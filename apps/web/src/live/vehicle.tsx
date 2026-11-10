import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Session } from '@supabase/supabase-js';
import { ExternalLink, Gauge, MapPinCheck, Navigation, ParkingSquare, RefreshCw } from 'lucide-react';
import type { Pickup, PickupAction } from '@deriro/contracts';
import { clockSeconds, copy } from '../copy.ts';
import type { ActionOptions, Change, DemoState, PairCode } from '../demo-domain.ts';
import { Button, useToast } from '../ui.tsx';
import { VehicleScreen } from '../vehicle.tsx';
import type { VehicleControls, VehicleOperations } from '../vehicle.tsx';
import { dataObject, pickupActionRpc, RpcError } from './api.ts';
import { Captcha } from './captcha.tsx';
import { describeError, useClient, useConnection, useLiveConfig, useSession } from './context.tsx';
import {
  alertParams,
  declineParams,
  driverParams,
  navResultParams,
  pairingState,
  pairStatusSchema,
  pairTicketSchema,
  transientErrors,
  vehicleFeedSchema,
  vehicleLinkErrors,
  vehicleStartSchema,
  vehicleState,
  vehicleStateParams,
  vehicleUpsertSchema,
} from './vehicle-models.ts';
import type { ActiveTrip, SimulatedVehicle } from './vehicle-models.ts';

const simulatorKey = 'deriro-vehicle-simulator';
const ticketKey = 'deriro-vehicle-pair-ticket';
const defaultSimulator: SimulatedVehicle = { parked: true, rangeKm: 48 };
// V-02 feed polling, as in the Kotlin client: 10 seconds, 30 seconds after a failure.
const feedPollMs = 10_000;
const feedRetryMs = 30_000;
// F-05 pairing status polling.
const pairPollMs = 3_000;
// The server accepts parked-only RPCs for 30 seconds after a gear P upload; refresh it well inside that window.
const parkedUploadMs = 20_000;
// F-06: while the ignition is on, upload at least every 5 minutes.
const drivingUploadMs = 300_000;

type Link = 'unknown' | 'paired' | 'unpaired';
type UploadRecord = { ok: boolean; parked: boolean; rangeKm: number; at: number };

function readSimulator(): SimulatedVehicle {
  try {
    const stored = JSON.parse(sessionStorage.getItem(simulatorKey) ?? 'null') as Partial<SimulatedVehicle> | null;
    if (stored && typeof stored.parked === 'boolean' && typeof stored.rangeKm === 'number') return { parked: stored.parked, rangeKm: stored.rangeKm };
  } catch { /* The defaults are fine without storage. */ }
  return defaultSimulator;
}

function readTicket(userId: string | null): PairCode | null {
  if (!userId) return null;
  try {
    const stored = JSON.parse(sessionStorage.getItem(ticketKey) ?? 'null') as (PairCode & { userId?: string }) | null;
    if (stored?.userId === userId && typeof stored.code === 'string' && stored.expiresAt > Date.now()) return { code: stored.code, expiresAt: stored.expiresAt };
  } catch { /* A new code can be made. */ }
  return null;
}

function writeStorage(key: string, value: unknown) {
  try {
    if (value == null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch { /* The simulator keeps working for this page. */ }
}

const errorCode = (error: unknown) => error instanceof RpcError ? error.code : '';
const pause = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

function VehicleMessage({ children }: { children: ReactNode }) {
  return (
    <main className="vehicle-layout">
      <section className="vehicle-screen">
        <header className="vehicle-header"><h1>{copy.app}</h1></header>
        <div className="vehicle-view" aria-live="polite">
          <div className="vehicle-main vehicle-center">{children}</div>
        </div>
      </section>
    </main>
  );
}

/** `/v/` in live mode with `VITE_LIVE_VEHICLE_SIM=true`: a real anonymous vehicle principal with simulated inputs. */
export default function LiveVehicle() {
  const session = useSession();
  useEffect(() => { document.title = `${copy.app} ${copy.simHeading}`; }, []);
  if (session === undefined) return <VehicleMessage><p>{copy.loading}</p></VehicleMessage>;
  return <LiveVehicleSurface session={session} />;
}

function LiveVehicleSurface({ session }: { session: Session | null }) {
  const client = useClient();
  const { captchaKey } = useLiveConfig();
  const query = useQueryClient();
  const toast = useToast();
  const browserOnline = useConnection();
  const userId = session?.user.id ?? null;
  const [sim, setSim] = useState(readSimulator);
  const [ticket, setTicket] = useState<PairCode | null>(() => readTicket(userId));
  const [link, setLink] = useState<Link>(userId ? 'unknown' : 'unpaired');
  const [pending, setPending] = useState(false);
  const [captcha, setCaptcha] = useState('');
  const [captchaRevision, setCaptchaRevision] = useState(0);
  const [upload, setUpload] = useState<UploadRecord | null>(null);
  // Navigation sessions this page received, oldest first. An older one is the "previous session" callback.
  const sessions = useRef<string[]>([]);
  // Server clock minus browser clock, so `collected_at` is never ahead of the server's parked check.
  const clockOffset = useRef(0);
  const announcePairing = useRef(false);

  const feed = useQuery({
    queryKey: ['vehicle-feed', userId],
    enabled: Boolean(userId) && link !== 'unpaired',
    queryFn: ({ signal }) => client.rpc('vehicle_get_feed', {}, vehicleFeedSchema, signal),
    refetchInterval: (current) => current.state.fetchFailureCount > 0 ? feedRetryMs : feedPollMs,
    refetchIntervalInBackground: true,
  });
  const pairStatus = useQuery({
    queryKey: ['vehicle-pair', userId, ticket?.code],
    enabled: Boolean(userId) && link === 'unpaired' && Boolean(ticket),
    queryFn: ({ signal }) => client.rpc('vehicle_pair_status', {}, pairStatusSchema, signal),
    refetchInterval: pairPollMs,
    refetchIntervalInBackground: true,
  });

  // Offline only when the server could not be reached; the last good feed stays on screen (V-02).
  const feedUnreachable = errorCode(feed.error) === 'NETWORK' && feed.errorUpdatedAt > feed.dataUpdatedAt;
  const online = browserOnline && !feedUnreachable;
  const state = useMemo<DemoState>(() => link === 'paired' && feed.data ?
    vehicleState(feed.data, sim, online, feed.dataUpdatedAt) :
    pairingState(ticket, sim, browserOnline), [link, feed.data, feed.dataUpdatedAt, sim, online, ticket, browserOnline]);
  const latest = useRef({ state, sim, online });
  useEffect(() => { latest.current = { state, sim, online }; });

  const saveTicket = useCallback((next: PairCode | null, owner: string | null) => {
    setTicket(next);
    writeStorage(ticketKey, next && owner ? { ...next, userId: owner } : null);
  }, []);
  const loseLink = useCallback((revoked: boolean) => {
    setLink('unpaired');
    saveTicket(null, null);
    setUpload(null);
    sessions.current = [];
    query.removeQueries({ queryKey: ['vehicle-feed'] });
    if (revoked) toast(copy.carLinkLost);
  }, [query, saveTicket, toast]);

  useEffect(() => {
    if (!feed.data || feed.dataUpdatedAt < feed.errorUpdatedAt) return;
    clockOffset.current = Date.parse(feed.data.server_time) - feed.dataUpdatedAt;
    setLink('paired');
    if (announcePairing.current) {
      announcePairing.current = false;
      toast(copy.carPaired(feed.data.vehicle.family_name ?? copy.brand));
    }
  }, [feed.data, feed.dataUpdatedAt, feed.errorUpdatedAt, toast]);
  useEffect(() => {
    const code = errorCode(feed.error);
    if (vehicleLinkErrors.has(code)) loseLink(code === 'VEHICLE_REVOKED');
  }, [feed.error, feed.errorUpdatedAt, loseLink]);
  useEffect(() => {
    if (!pairStatus.data?.paired) return;
    announcePairing.current = true;
    saveTicket(null, null);
    setLink('paired');
  }, [pairStatus.data, saveTicket]);

  const uploadState = useCallback(async (value: SimulatedVehicle) => {
    const at = new Date(Date.now() + clockOffset.current);
    try {
      await client.rpc('upsert_vehicle_state', vehicleStateParams(value, at), vehicleUpsertSchema);
      setUpload({ ok: true, parked: value.parked, rangeKm: value.rangeKm, at: at.getTime() });
    } catch (error) {
      setUpload({ ok: false, parked: value.parked, rangeKm: value.rangeKm, at: at.getTime() });
      throw error;
    }
  }, [client]);

  // F-06: on every change (debounced for the range slider) and on a cadence that keeps parked-only RPCs usable.
  useEffect(() => {
    if (link !== 'paired') return;
    let stopped = false;
    const send = () => {
      void uploadState(latest.current.sim).catch((error: unknown) => {
        const code = errorCode(error);
        if (!stopped && vehicleLinkErrors.has(code)) loseLink(code === 'VEHICLE_REVOKED');
      });
    };
    const first = window.setTimeout(send, 300);
    const timer = window.setInterval(send, sim.parked ? parkedUploadMs : drivingUploadMs);
    return () => {
      stopped = true;
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [link, sim.parked, sim.rangeKm, uploadState, loseLink]);

  async function refresh(): Promise<DemoState> {
    try {
      const result = await feed.refetch();
      const { sim: current, online: reachable } = latest.current;
      return result.data ? vehicleState(result.data, current, reachable, result.dataUpdatedAt) : latest.current.state;
    } catch {
      return latest.current.state;
    }
  }

  /** Parked-only RPCs re-send gear P right before they run, as the Kotlin client does (F-06, V-00). */
  async function sendParkState() {
    const current = latest.current.sim;
    if (!current.parked) throw new RpcError('PARK_REQUIRED');
    await uploadState(current);
  }

  function fail(error: unknown) {
    const code = errorCode(error);
    toast(describeError(error));
    if (vehicleLinkErrors.has(code)) loseLink(code === 'VEHICLE_REVOKED');
  }

  async function run(task: () => Promise<void>, { parked = false, reload = true } = {}) {
    if (!latest.current.online) {
      toast(copy.offlineMessage);
      return false;
    }
    setPending(true);
    try {
      if (parked) await sendParkState();
      await task();
      if (reload) await refresh();
      return true;
    } catch (error) {
      fail(error);
      if (reload) await refresh();
      return false;
    } finally {
      setPending(false);
    }
  }

  /** "출발하고 안내": departure is final once the server answers; a lost answer is resent with the same action ID. */
  async function startNow(pickup: Pickup, action: PickupAction) {
    const [name, args] = pickupActionRpc(pickup.id, action, 'vehicle');
    let started;
    try {
      started = await client.rpc(name, args, vehicleStartSchema);
    } catch (error) {
      if (!transientErrors.has(errorCode(error))) throw error;
      await pause(300);
      started = await client.rpc(name, args, vehicleStartSchema);
    }
    sessions.current = [...sessions.current.filter((id) => id !== started.nav_session_id), started.nav_session_id];
  }

  async function act(pickup: Pickup, action: PickupAction, message?: string, options?: ActionOptions): Promise<Change> {
    if (!latest.current.online) {
      toast(copy.offlineMessage);
      return { ok: false, state: latest.current.state, code: 'NETWORK' };
    }
    const parked = action.type === 'board' || action.type === 'confirm_location' || action.type === 'vehicle_start' && Boolean(options?.confirmedSwitch);
    setPending(true);
    try {
      if (parked) await sendParkState();
      let ignored = false;
      if (action.type === 'vehicle_start') {
        await startNow(pickup, action);
      } else {
        const [name, args] = pickupActionRpc(pickup.id, action, 'vehicle');
        const result = await client.rpc(name, args, dataObject);
        ignored = result.ignored === true;
      }
      if (message) toast(message);
      return { ok: true, state: await refresh(), ignored: ignored ? true : undefined };
    } catch (error) {
      fail(error);
      return { ok: false, state: await refresh(), code: errorCode(error) || 'NETWORK' };
    } finally {
      setPending(false);
    }
  }

  async function startPairing() {
    setPending(true);
    try {
      let owner = userId;
      const { data } = await client.supabase.auth.getSession();
      if (!data.session) {
        if (captchaKey && !captcha) throw new RpcError('CAPTCHA_REQUIRED');
        const signedIn = await client.supabase.auth.signInAnonymously({ options: { captchaToken: captcha || undefined } });
        setCaptcha('');
        setCaptchaRevision((value) => value + 1);
        if (signedIn.error) throw new RpcError(signedIn.error.status === 429 ? 'RATE_LIMITED' : 'NOT_AUTHENTICATED');
        owner = signedIn.data.user?.id ?? null;
      } else {
        owner = data.session.user.id;
      }
      const next = await client.rpc('vehicle_pair_start', {}, pairTicketSchema);
      saveTicket(next, owner);
    } catch (error) {
      // INVALID_STATE: this session is already a paired vehicle. The feed decides what to show.
      if (errorCode(error) === 'INVALID_STATE') setLink('unknown');
      else toast(describeError(error));
    } finally {
      setPending(false);
    }
  }

  function updateVehicle(fields: VehicleControls) {
    setSim((current) => {
      const next = { parked: fields.parked ?? current.parked, rangeKm: fields.range ?? current.rangeKm };
      writeStorage(simulatorKey, next);
      return next;
    });
  }

  const captchaMissing = !userId && Boolean(captchaKey) && !captcha;
  const operations: VehicleOperations = {
    live: true,
    pending: pending || link !== 'paired' && captchaMissing,
    act,
    cannotGo: (pickup) => run(async () => {
      await client.rpc('vehicle_decline', declineParams(pickup), dataObject);
      toast(copy.carDeclinedOthers);
    }),
    updateVehicle,
    renewPairCode: startPairing,
    async unpair() {
      const done = await run(async () => {
        await client.rpc('vehicle_unpair_self', {}, dataObject);
      }, { parked: true, reload: false });
      if (done) {
        toast(copy.carUnpaired);
        loseLink(false);
        await startPairing();
      }
      return done;
    },
    setDriver: (memberId, name) => run(async () => {
      await client.rpc('vehicle_set_driver', driverParams(memberId), dataObject);
      toast(copy.carDriverChanged(name));
    }, { parked: true }),
    acknowledgeAlert: (alertId) => run(async () => {
      await client.rpc('ack_vehicle_alert', alertParams(alertId), dataObject);
    }, { parked: true }),
    pairingPrompt: !userId && captchaKey ? <Captcha key={captchaRevision} siteKey={captchaKey} receive={setCaptcha} /> : undefined,
  };

  const trip = link === 'paired' ? feed.data?.active_trip ?? null : null;
  async function reportNavigation(ok: boolean) {
    const sessionId = trip?.nav_session_id;
    if (!trip || !sessionId) return;
    await run(async () => {
      await client.rpc('report_nav_result', navResultParams(trip.pickup_id, sessionId, ok), dataObject);
    });
  }
  async function arrivalCallback(previous: boolean) {
    const sessionId = trip?.nav_session_id;
    const pickup = state.pickups.find((item) => item.id === trip?.pickup_id);
    if (!trip || !sessionId || trip.destination_revision == null || !pickup) return;
    // A session this page used before the current one, or one the server never issued.
    const older = [...sessions.current].reverse().find((id) => id !== sessionId) ?? crypto.randomUUID();
    const action: PickupAction = {
      type: 'arrive',
      source: 'nav_callback',
      sessionId: previous ? older : sessionId,
      destinationRevision: trip.destination_revision,
    };
    const result = await act(pickup, action);
    if (result.ok) toast(result.ignored ? copy.carIgnoredCallback : copy.simArrivalApplied);
  }

  if (link === 'unknown') {
    if (feed.isError && !vehicleLinkErrors.has(errorCode(feed.error))) {
      return (
        <VehicleMessage>
          <p>{describeError(feed.error)}</p>
          <Button variant="amber" onClick={() => { void feed.refetch(); }}>{copy.retry}</Button>
        </VehicleMessage>
      );
    }
    return <VehicleMessage><p>{copy.loading}</p></VehicleMessage>;
  }
  const pairHref = ticket ? new URL(`/p/vehicles/pair?code=${ticket.code}`, window.location.origin).href : null;
  const simulator = (
    <VehicleSimulator
      sim={sim}
      change={updateVehicle}
      upload={upload}
      trip={trip}
      pairHref={link === 'unpaired' ? pairHref : null}
      busy={pending || !online}
      reportNavigation={(ok) => { void reportNavigation(ok); }}
      arrivalCallback={(previous) => { void arrivalCallback(previous); }}
      refresh={link === 'paired' ? () => { void feed.refetch(); } : undefined}
    />
  );
  return <VehicleScreen key={state.vehicle.id || 'pairing'} state={state} operations={operations} simulator={simulator} />;
}

type SimulatorProps = {
  sim: SimulatedVehicle;
  change: (fields: VehicleControls) => void;
  upload: UploadRecord | null;
  trip: ActiveTrip | null;
  pairHref: string | null;
  busy: boolean;
  reportNavigation: (ok: boolean) => void;
  arrivalCallback: (previous: boolean) => void;
  refresh?: () => void;
};

/**
 * Inputs a real car would produce: gear and range readings, the navigation outcome and its arrival callback. They sit
 * outside the car screen and are labelled as simulated; the server session behind them is real.
 */
function VehicleSimulator({ sim, change, upload, trip, pairHref, busy, reportNavigation, arrivalCallback, refresh }: SimulatorProps) {
  const headingId = useId();
  const sessionId = trip?.nav_session_id;
  const guiding = trip?.status === 'en_route' && sessionId != null && trip.destination_revision != null;
  let uploadText: string = copy.simUploadNone;
  if (upload) uploadText = upload.ok ? copy.simUploadValue(upload.parked ? 'P' : 'D', upload.rangeKm, clockSeconds(upload.at)) : copy.simUploadFailed;
  let navText: string = copy.simNavIdle;
  if (guiding && trip.nav_status === 'requested') navText = copy.simNavWaiting;
  else if (guiding && trip.nav_status === 'ok') navText = copy.simNavRecordedOk;
  else if (guiding && trip.nav_status === 'failed') navText = copy.simNavRecordedFailed;
  return (
    <section className="vehicle-sim" aria-labelledby={headingId}>
      <header className="vehicle-sim-header">
        <h2 id={headingId}>{copy.simHeading}</h2>
        <span className="vehicle-sim-badge">{copy.simLiveBadge}</span>
        <span className="vehicle-sim-badge vehicle-sim-badge--demo">{copy.demoValue}</span>
      </header>
      <p className="vehicle-sim-notice">{copy.simNotice}</p>
      <div className="vehicle-sim-grid">
        <div className="vehicle-sim-group">
          <h3><ParkingSquare size={16} aria-hidden="true" />{copy.simGear}</h3>
          <div className="vehicle-sim-row" role="group" aria-label={copy.simGear}>
            <Button variant={sim.parked ? 'amber' : 'outline'} aria-pressed={sim.parked} onClick={() => change({ parked: true })}>{copy.simParked}</Button>
            <Button variant={sim.parked ? 'outline' : 'amber'} aria-pressed={!sim.parked} onClick={() => change({ parked: false })}>{copy.simDriving}</Button>
          </div>
        </div>
        <div className="vehicle-sim-group">
          <h3><Gauge size={16} aria-hidden="true" />{copy.rangeTitle}<output>{sim.rangeKm}km</output></h3>
          <input aria-label={copy.rangeTitle} type="range" min="0" max="600" step="1" value={sim.rangeKm}
            onChange={(event) => change({ range: Number(event.target.value) })} />
          <small>{copy.simUpload} {uploadText}</small>
        </div>
        <div className="vehicle-sim-group">
          <h3><Navigation size={16} aria-hidden="true" />{copy.simNav}</h3>
          <p>{navText}</p>
          {guiding && <small>{copy.simSession(sessionId, trip.destination_revision ?? 0)}</small>}
          {guiding && trip.nav_status === 'requested' && (
            <div className="vehicle-sim-row">
              <Button variant="outline" disabled={busy} onClick={() => reportNavigation(true)}>{copy.simNavOk}</Button>
              <Button variant="outline" disabled={busy} onClick={() => reportNavigation(false)}>{copy.simNavFail}</Button>
            </div>
          )}
        </div>
        <div className="vehicle-sim-group">
          <h3><MapPinCheck size={16} aria-hidden="true" />{copy.simArrival}</h3>
          {guiding ? (
            <div className="vehicle-sim-row">
              <Button variant="outline" disabled={busy} onClick={() => arrivalCallback(false)}>{copy.carCurrentCallback}</Button>
              <Button variant="outline" disabled={busy} onClick={() => arrivalCallback(true)}>{copy.carPreviousCallback}</Button>
            </div>
          ) : <p>{copy.simNavIdle}</p>}
        </div>
        {(pairHref || refresh) && (
          <div className="vehicle-sim-group vehicle-sim-links">
            {pairHref && (
              <a className="button button--outline" href={pairHref} target="_blank" rel="noreferrer">
                <ExternalLink size={16} aria-hidden="true" />{copy.simPairLink}
              </a>
            )}
            {refresh && <Button variant="outline" onClick={refresh}><RefreshCw size={16} aria-hidden="true" />{copy.simRefresh}</Button>}
          </div>
        )}
      </div>
    </section>
  );
}
