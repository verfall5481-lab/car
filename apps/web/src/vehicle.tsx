import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Battery, CalendarDays, CarFront, Check, CircleAlert, Clock3, Gauge, MapPin, ParkingSquare, Settings, SlidersHorizontal, TriangleAlert, UserRound } from 'lucide-react';
import QRCode from 'qrcode';
import { isActivePickup, resolveDestination } from '@deriro/contracts';
import type { Actor, Pickup, PickupAction } from '@deriro/contracts';
import { clock, copy } from './copy.ts';
import { changed, destinationLabel, formatPairCode, minute, nameOf, nearbyPlaces, renewPairCode, setVehicleDriver, unpairVehicle, vehiclePaired } from './demo-domain.ts';
import type { ActionOptions, Change, DemoState, DemoVehicle, PairCode } from './demo-domain.ts';
import { Button, MapPreview, Row, Status, uid, useClock, useCommit, usePickupAction, useToast } from './ui.tsx';
import { vehicleView } from './vehicle-view.ts';
import './vehicle.css';

/** Values the simulator controls change. Live mode keeps them in the browser and uploads them as demo values. */
export type VehicleControls = Partial<Pick<DemoVehicle, 'parked' | 'range' | 'online' | 'navFails'>>;

/**
 * Everything the car screen asks of its data source. The demo applies each call to the shared browser store;
 * the live web simulator sends authenticated vehicle RPCs (`src/live/vehicle.tsx`).
 */
export type VehicleOperations = {
  /** A real server session with simulated vehicle values and simulated navigation. */
  live: boolean;
  /** A request is in flight. Buttons stay disabled so one press is sent once (V-03). */
  pending: boolean;
  act(pickup: Pickup, action: PickupAction, message?: string, options?: ActionOptions): Promise<Change>;
  /** F-12 "못 가요". */
  cannotGo(pickup: Pickup): Promise<unknown>;
  updateVehicle(fields: VehicleControls): void;
  renewPairCode(): Promise<unknown>;
  /** Resolves true once the car is disconnected. */
  unpair(): Promise<boolean>;
  setDriver(memberId: string, name: string): Promise<unknown>;
  /** V-07 warning that came from the server. */
  acknowledgeAlert(alertId: string): Promise<unknown>;
  /** Shown under the pairing steps, for example the security check before the anonymous sign-in. */
  pairingPrompt?: ReactNode;
};

/** Today's demo behaviour: every call is a transaction on the shared browser store. */
export function useDemoVehicleOperations(state: DemoState): VehicleOperations {
  const commit = useCommit();
  const act = usePickupAction();
  const { vehicle } = state;
  const driverId = vehicle.currentDriverId ?? '';
  const actor: Actor = { kind: 'vehicle', id: vehicle.id, driverId, parked: vehicle.parked };
  return {
    live: false,
    pending: false,
    act: (pickup, action, message, options) => act(pickup, actor, action, message, options),
    // F-12 "못 가요": an open request records this driver's refusal; an assigned pickup asks everyone while staying assigned.
    async cannotGo(item) {
      const offer = item.offer;
      if (item.status === 'open') {
        if (offer?.status === 'pending' && offer.fromMemberId == null && !offer.declinedBy.includes(driverId)) {
          const decline: PickupAction = { type: 'respond_offer', expectedVersion: item.version, offerId: offer.id, response: 'decline' };
          await act(item, actor, decline, copy.carDeclinedOthers);
          return;
        }
        await commit((current, at) => changed({
          ...current,
          history: [{ pickupId: item.id, at, event: 'request_declined', actor: driverId }, ...current.history],
        }), copy.carDeclinedOthers);
        return;
      }
      await act(item, actor, { type: 'offer', expectedVersion: item.version, offerId: uid() }, copy.carDeclinedOthers);
    },
    updateVehicle(fields) {
      void commit((current) => changed({ ...current, vehicle: { ...current.vehicle, ...fields } }));
    },
    renewPairCode: () => commit((current, at) => renewPairCode(current, at)),
    async unpair() {
      const result = await commit((current, at) => unpairVehicle(current, at), copy.carUnpaired);
      return result.ok;
    },
    setDriver: (memberId, name) => commit((current) => setVehicleDriver(current, memberId), copy.carDriverChanged(name)),
    acknowledgeAlert: async () => undefined,
  };
}

export function DemoVehicleScreen({ state }: { state: DemoState }) {
  const operations = useDemoVehicleOperations(state);
  return <VehicleScreen state={state} operations={operations} />;
}

function VehicleQr({ href, label }: { href: string; label: string }) {
  const [image, setImage] = useState<{ href: string; data: string }>();
  useEffect(() => {
    let active = true;
    void QRCode.toDataURL(href, { width: 220, margin: 2, errorCorrectionLevel: 'M' })
      .then((data) => { if (active) setImage({ href, data }); })
      .catch(() => {});
    return () => { active = false; };
  }, [href]);
  return (
    <figure className="vehicle-qr">
      {image?.href === href ? <img src={image.data} width="150" height="150" alt={label} /> : <span className="vehicle-qr-blank" />}
      <figcaption>{label}</figcaption>
    </figure>
  );
}

/** V-01: the car shows a short-lived code; a family phone confirms it on P-14. */
function VehiclePairing({ pairing, now, live, prompt }: { pairing: PairCode | null | undefined; now: number; live: boolean; prompt?: ReactNode }) {
  const seconds = pairing ? Math.max(0, Math.floor((pairing.expiresAt - now) / 1000)) : 0;
  const href = pairing ? new URL(`/p/vehicles/pair?code=${pairing.code}`, window.location.origin).href : '';
  const missing = live && !pairing ? copy.carPairPrompt : copy.carPairExpired;
  return (
    <div className="vehicle-pair">
      <div className="vehicle-main">
        <h2>{copy.carPairTitle}</h2>
        <ol className="vehicle-steps">{copy.carPairSteps.map((step) => <li key={step}>{step}</li>)}</ol>
        {seconds > 0 && pairing ? (
          <p className="vehicle-pair-code">
            <span>{copy.carPairCode}</span>
            <strong>{formatPairCode(pairing.code)}</strong>
          </p>
        ) : (
          <p className="vehicle-error"><Clock3 aria-hidden="true" />{missing}</p>
        )}
        {prompt}
      </div>
      {seconds > 0 && (
        <div className="vehicle-pair-qr">
          <VehicleQr href={href} label={live ? copy.inviteQr : copy.demoQrLabel} />
          <span><Clock3 size={16} aria-hidden="true" />{copy.carPairRemaining(seconds)}</span>
        </div>
      )}
    </div>
  );
}

type ScreenMode = 'home' | 'list' | 'controls' | 'settings' | 'unpair';

export function VehicleScreen({ state, operations, simulator }: { state: DemoState; operations: VehicleOperations; simulator?: ReactNode }) {
  const { vehicle } = state;
  const paired = vehiclePaired(vehicle);
  const now = useClock(state);
  const toast = useToast();
  const [mode, setMode] = useState<ScreenMode>('home');
  const [map, setMap] = useState<string | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [hidden, setHidden] = useState<string[]>([]);
  const [rangeSeen, setRangeSeen] = useState(false);
  const [manual, setManual] = useState<string | null>(null);
  const [seenOffers, setSeenOffers] = useState<string[]>([]);
  const model = vehicleView(state, now, { hidden, seenOffers, rangeSeen });
  const { driverId, active, pending, cards, pickup, rangeWarning } = model;
  const driver = nameOf(state, vehicle.currentDriverId);
  // Offline, or waiting for the answer to the previous press.
  const busy = !vehicle.online || operations.pending;
  const showControls = mode === 'controls' && vehicle.parked;
  const showList = mode === 'list' && vehicle.parked && paired;
  const showSettings = (mode === 'settings' || mode === 'unpair') && vehicle.parked && paired;
  const mapPickup = paired && vehicle.parked && map ? state.pickups.find((item) => item.id === map && isActivePickup(item)) : undefined;
  const switchPickup = paired && vehicle.parked && next ? state.pickups.find((item) => item.id === next && isActivePickup(item)) : undefined;
  const drivers = state.members.filter((person) => person.canDrive && person.leftAt == null);

  async function chooseDriver(id: string) {
    await operations.setDriver(id, nameOf(state, id));
  }
  async function unpair() {
    if (await operations.unpair()) {
      setMode('home');
      setHidden([]);
      setSeenOffers([]);
    }
  }
  function patch(fields: VehicleControls) {
    operations.updateVehicle(fields);
  }
  function doAction(item: Pickup, action: PickupAction, message?: string) {
    return operations.act(item, action, message);
  }
  async function start(item: Pickup, confirmedSwitch = false) {
    if (!item.destination.confirmed) {
      if (vehicle.parked) setMap(item.id);
      return;
    }
    if (active && active.id !== item.id && !confirmedSwitch) {
      if (vehicle.parked) setNext(item.id);
      return;
    }
    setMode('home');
    setManual(null);
    // A new action ID for every press; the live client reuses it only to retry the same press (8.3.1).
    const action: PickupAction = { type: 'vehicle_start', expectedVersion: item.version, sessionId: uid(), actionId: uid(), offerId: item.offer?.id };
    const result = await operations.act(item, action, undefined, { confirmedSwitch });
    if (result.ok && !result.state.vehicle.navError) toast(operations.live ? copy.carSimNavRequested : copy.openNavDemo);
    else if (!result.ok) closeIfTaken(item, result.state);
  }
  function dismiss(item: Pickup) {
    setHidden((ids) => [...ids, item.id]);
  }
  // V-03: when another member took the pickup first, say who and close the card after 3 seconds.
  function closeIfTaken(item: Pickup, latestState: DemoState) {
    const latest = latestState.pickups.find(({ id }) => id === item.id);
    if (!latest?.assigneeId || latest.assigneeId === driverId) return;
    toast(copy.carTakenBy(nameOf(latestState, latest.assigneeId)));
    window.setTimeout(() => dismiss(item), 3000);
  }
  async function answerOffer(item: Pickup, offerId: string, response: 'accept' | 'decline', from: string) {
    const action: PickupAction = { type: 'respond_offer', expectedVersion: item.version, offerId, response };
    const result = await doAction(item, action, response === 'decline' ? copy.carDeclinedTo(from) : undefined);
    if (!result.ok) closeIfTaken(item, result.state);
  }
  // F-10: the server's "수락" only takes the pickup; departure comes later from the card.
  async function accept(item: Pickup) {
    const offer = model.receivedOffer(item);
    const action: PickupAction = offer ?
      { type: 'respond_offer', expectedVersion: item.version, offerId: offer.id, response: 'accept' } :
      { type: 'accept' };
    const result = await doAction(item, action);
    if (!result.ok) closeIfTaken(item, result.state);
  }
  async function confirmLocation(item: Pickup, placeId?: string) {
    const destination = placeId ?
      resolveDestination(item.familyId, { source: 'saved_place', placeId }, state.places) :
      { ...item.destination, confirmed: true };
    if (!destination) return;
    const result = await doAction(item, { type: 'confirm_location', expectedVersion: item.version, destination });
    if (result.ok) setMap(null);
  }
  function arrivalCallback(previous: boolean) {
    if (!active?.navigation) return;
    const sessionId = previous ? 'old-demo-navigation' : active.navigation.sessionId;
    const action: PickupAction = { type: 'arrive', source: 'nav_callback', sessionId, destinationRevision: active.navigation.destinationRevision };
    void doAction(active, action).then((result) => {
      if (result.ok && result.ignored) toast(copy.carIgnoredCallback);
    });
  }
  function toggleMode(target: ScreenMode, shown: boolean) {
    setMap(null);
    setNext(null);
    setMode(shown ? 'home' : target);
  }

  let view;
  let buttons;
  let inlineList = false;
  let panelShown = false;
  const carPanel = (
    <aside className="vehicle-meta">
      <strong><CarFront />{vehicle.name}</strong>
      <span><Battery />{copy.range(vehicle.rangeStale ? null : vehicle.range)}</span>
      <span><UserRound />{copy.driver} {driver}</span>
      <span className={`vehicle-connection${vehicle.online ? '' : ' vehicle-connection--offline'}`}>{vehicle.online ? copy.connected : copy.offline}</span>
      {!vehicle.online && <small>{operations.live ? copy.carOfflineLiveHint : copy.carOfflineHint}</small>}
      <button type="button" className="vehicle-settings-link" onClick={() => setMode('settings')}><Settings aria-hidden="true" />{copy.settings}</button>
    </aside>
  );
  if (mapPickup) {
    // The demo shows its example accuracy; live mode shows the server's value only when it has one.
    const accuracy = operations.live ? model.accuracyM(mapPickup) : null;
    view = (
      <div className="vehicle-location">
        <MapPreview coords={mapPickup.destination} uncertain live={operations.live} />
        <div className="vehicle-main">
          <h2>{copy.confirmLocation}</h2>
          <p>{mapPickup.destination.label}</p>
          {operations.live ? accuracy != null && <small>{copy.mapAccuracy(accuracy)}</small> : <small>{copy.mapAcc}</small>}
          <div className="vehicle-nearby">
            <h3>{copy.nearbyPlaces}</h3>
            {nearbyPlaces(state, mapPickup.destination).map(({ place, distance }) => (
              <Button key={place.id} variant="secondary" disabled={busy} onClick={() => { void confirmLocation(mapPickup, place.id); }}>
                <MapPin size={18} />{place.label}<small>{copy.distance(distance)}</small>
              </Button>
            ))}
          </div>
        </div>
      </div>
    );
    buttons = (
      <>
        <Button variant="amber" disabled={busy} onClick={() => { void confirmLocation(mapPickup); }}>{copy.confirmHere}</Button>
        <Button variant="secondary" onClick={() => setMap(null)}>{copy.back}</Button>
      </>
    );
  } else if (switchPickup) {
    view = <div className="vehicle-main"><h2>{copy.navSwitch(nameOf(state, switchPickup.requester.id))}</h2></div>;
    buttons = (
      <>
        <Button variant="amber" disabled={busy} onClick={() => { void start(switchPickup, true); setNext(null); }}>{copy.navChange}</Button>
        <Button variant="secondary" onClick={() => setNext(null)}>{copy.cancelNo}</Button>
      </>
    );
  } else if (showControls) {
    view = (
      <div className="vehicle-control">
        <h2>{copy.demoTools}</h2>
        <label className="vehicle-option">
          <span><Gauge size={22} />{copy.rangeTitle}</span>
          <output>{vehicle.range ?? 0}km</output>
          <input aria-label={copy.rangeTitle} type="range" min="0" max="150" step="1" value={vehicle.range ?? 0}
            onChange={(event) => { patch({ range: Number(event.target.value) }); setRangeSeen(false); }} />
        </label>
        <div className="vehicle-option">
          <span>{copy.driveMode}</span>
          <div className="actions">
            <Button variant="amber" aria-pressed={vehicle.parked} onClick={() => patch({ parked: true })}>{copy.parked}</Button>
            <Button variant="secondary" onClick={() => { patch({ parked: false }); setMode('home'); }}>{copy.driving}</Button>
          </div>
        </div>
        <div className="vehicle-option">
          <span>{copy.network}</span>
          <div className="actions">
            <Button variant={vehicle.online ? 'amber' : 'secondary'} aria-pressed={vehicle.online} onClick={() => patch({ online: true })}>{copy.connected}</Button>
            <Button variant={!vehicle.online ? 'amber' : 'secondary'} aria-pressed={!vehicle.online} onClick={() => patch({ online: false })}>{copy.offline}</Button>
          </div>
        </div>
        <div className="vehicle-option">
          <span>{copy.navState}</span>
          <div className="actions">
            <Button variant={!vehicle.navFails ? 'amber' : 'secondary'} aria-pressed={!vehicle.navFails} onClick={() => patch({ navFails: false })}>{copy.navSuccess}</Button>
            <Button variant={vehicle.navFails ? 'amber' : 'secondary'} aria-pressed={vehicle.navFails} onClick={() => patch({ navFails: true })}>{copy.navFail}</Button>
          </div>
        </div>
        {active?.navigation && (
          <div className="vehicle-callbacks">
            <Button variant="secondary" disabled={busy} onClick={() => arrivalCallback(false)}>{copy.carCurrentCallback}</Button>
            <Button variant="secondary" disabled={busy} onClick={() => arrivalCallback(true)}>{copy.carPreviousCallback}</Button>
          </div>
        )}
      </div>
    );
    buttons = <Button variant="amber" onClick={() => setMode('home')}>{copy.back}</Button>;
  } else if (!paired) {
    view = vehicle.parked ? (
      <VehiclePairing pairing={vehicle.pairing} now={now} live={operations.live} prompt={operations.pairingPrompt} />
    ) : (
      <div className="vehicle-main vehicle-center vehicle-empty"><CarFront aria-hidden="true" /><h2>{copy.carStopToPair}</h2></div>
    );
    const expired = !vehicle.pairing || vehicle.pairing.expiresAt <= now;
    const label = operations.live && !vehicle.pairing ? copy.carPairCreate : copy.newCode;
    if (vehicle.parked) {
      buttons = (
        <Button variant={expired ? 'amber' : 'secondary'} disabled={operations.pending} onClick={() => { void operations.renewPairCode(); }}>{label}</Button>
      );
    }
  } else if (showSettings && mode === 'unpair') {
    view = (
      <div className="vehicle-alert">
        <TriangleAlert aria-hidden="true" />
        <div className="vehicle-main"><h2>{copy.carDisconnectQuestion}</h2><p>{copy.carUnpairDesc}</p></div>
      </div>
    );
    buttons = (
      <>
        <Button variant="amber" disabled={busy} onClick={() => { void unpair(); }}>{copy.disconnect}</Button>
        <Button variant="secondary" onClick={() => setMode('settings')}>{copy.back}</Button>
      </>
    );
  } else if (showSettings) {
    // V-09: who is driving decides which cards are "mine"; changing it is a parked-only action.
    view = (
      <div className="vehicle-control vehicle-settings">
        <h2>{copy.currentDriver}</h2>
        <div className="vehicle-drivers" role="group" aria-label={copy.currentDriver}>
          {drivers.map((person) => (
            <Button key={person.id} variant={person.id === driverId ? 'amber' : 'secondary'} aria-pressed={person.id === driverId}
              disabled={busy || Boolean(vehicle.activePickupId)} onClick={() => { if (person.id !== driverId) void chooseDriver(person.id); }}>
              {person.name}
            </Button>
          ))}
        </div>
        {vehicle.activePickupId && <small className="vehicle-hint">{copy.carDriverBusy}</small>}
        <dl className="vehicle-facts">
          <div><dt>{copy.carNickname}</dt><dd>{vehicle.name}</dd></div>
          <div><dt>{copy.carConnectedFamily}</dt><dd>{state.familyName}</dd></div>
        </dl>
      </div>
    );
    buttons = (
      <>
        <Button variant="amber" onClick={() => setMode('home')}>{copy.back}</Button>
        <Button variant="secondary" className="vehicle-danger" disabled={busy} onClick={() => setMode('unpair')}>{copy.disconnect}</Button>
      </>
    );
  } else if (showList) {
    view = (
      <div className="vehicle-control">
        <h2>{copy.carList}</h2>
        {pending.length ? pending.map((item) => (
          <Row key={item.id} onClick={busy ? undefined : () => { void start(item); }} icon={<time>{clock(item.wantedAt)}</time>}
            title={`${nameOf(state, item.requester.id)}, ${destinationLabel(state, item.destination)}`}
            caption={item.assigneeId ? `${copy.assignee} ${nameOf(state, item.assigneeId)}` : undefined} trailing={<Status pickup={item} />} />
        )) : <p>{copy.noCarPickups}</p>}
      </div>
    );
    buttons = <Button variant="amber" onClick={() => setMode('home')}>{copy.back}</Button>;
  } else if (rangeWarning && vehicle.parked && !active) {
    const { alertId } = rangeWarning;
    const detail = rangeWarning.pickupCount != null ? copy.rangePickups(rangeWarning.pickupCount) : `${copy.rangeEstimate} ${copy.homeOrigin}`;
    view = (
      <div className="vehicle-alert vehicle-alert--range">
        <Gauge aria-hidden="true" />
        <div className="vehicle-main">
          <h2>{copy.rangeWarning(rangeWarning.requiredKm)}</h2>
          <p>{copy.rangeCurrent(rangeWarning.rangeKm)}</p>
          <small>{detail}</small>
        </div>
      </div>
    );
    buttons = (
      <Button variant="amber" disabled={Boolean(alertId) && busy} onClick={() => { if (alertId) void operations.acknowledgeAlert(alertId); else setRangeSeen(true); }}>
        {copy.confirm}
      </Button>
    );
  } else if (!pickup) {
    view = (
      <div className="vehicle-split">
        <div className="vehicle-main vehicle-empty"><CalendarDays aria-hidden="true" /><h2>{copy.noCarPickups}</h2></div>
        {vehicle.parked && carPanel}
      </div>
    );
    panelShown = vehicle.parked;
  } else {
    const name = nameOf(state, pickup.requester.id);
    const place = destinationLabel(state, pickup.destination);
    if (pickup.status === 'completed') {
      view = (
        <div className="vehicle-main vehicle-center">
          <span className="vehicle-success"><Check aria-hidden="true" /></span>
          <h2>{copy.carCompleted}</h2>
          <p>{name}, {place}</p>
        </div>
      );
      buttons = <Button variant="amber" onClick={() => dismiss(pickup)}>{copy.confirm}</Button>;
    } else if (pickup.status === 'cancelled') {
      view = (
        <div className="vehicle-alert">
          <TriangleAlert aria-hidden="true" />
          <div className="vehicle-main"><h2>{copy.carCancelled(name)}</h2><p>{copy.carCancelDesc}</p></div>
        </div>
      );
      buttons = <Button variant="amber" onClick={() => dismiss(pickup)}>{copy.confirm}</Button>;
    } else if (pickup.status === 'arrived') {
      const late = pickup.arrivedAt != null && now >= pickup.arrivedAt + 30 * minute;
      const notMet = pickup.notMetAt != null;
      view = notMet ? (
        <div className="vehicle-alert">
          <CircleAlert aria-hidden="true" />
          <div className="vehicle-main"><h2>{copy.notMetHeadline(name)}</h2><p>{place}. {copy.carNotMetHint}</p></div>
        </div>
      ) : (
        <div className="vehicle-split vehicle-split--arrival">
          <div className="vehicle-main">
            <h2>{late ? copy.boardingCheck(name) : copy.arrival}</h2>
            <p>{late ? copy.boardingLate : copy.carNotify(name)}</p>
            {!vehicle.parked && <small>{copy.carParkToBoard}</small>}
          </div>
          {vehicle.parked && !late && (
            <aside className="vehicle-meta"><strong className="vehicle-arrived">{copy.statuses.arrived}</strong><span>{copy.parked}</span></aside>
          )}
        </div>
      );
      buttons = (
        <Button variant="amber" disabled={busy || !vehicle.parked} onClick={() => { void doAction(pickup, { type: 'board', expectedVersion: pickup.version }); }}>
          {copy.boarded}
        </Button>
      );
    } else if (pickup.status === 'en_route') {
      const failed = vehicle.navError && manual !== pickup.id;
      view = (
        <div className="vehicle-main">
          <h2>{copy.driveTo(name)}</h2>
          <p>{place}</p>
          {failed && <p className="vehicle-error"><TriangleAlert aria-hidden="true" />{copy.failNav}</p>}
        </div>
      );
      buttons = failed ? (
        <>
          <Button variant="amber" disabled={busy} onClick={() => { void start(pickup); }}>{copy.navRetry}</Button>
          <Button variant="secondary" onClick={() => setManual(pickup.id)}>{copy.navManual}</Button>
        </>
      ) : (
        <>
          <Button variant="amber" disabled={busy} onClick={() => { void doAction(pickup, { type: 'arrive', source: 'manual', expectedVersion: pickup.version }); }}>
            {copy.arrival}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => { void start(pickup); }}>{copy.reopenNav}</Button>
        </>
      );
    } else {
      const received = model.receivedOffer(pickup);
      const unanswered = model.unansweredOffer(pickup);
      const alert = model.departureAlert(pickup);
      const sentPending = pickup.offer?.status === 'pending' && pickup.offer.fromMemberId === driverId ? pickup.offer : null;
      const requiredKm = model.requiredKm(pickup);
      const rangeLine = requiredKm != null && <small>{copy.rangeNeed(requiredKm)}, {copy.range(vehicle.rangeStale ? null : vehicle.range)}</small>;
      const others = model.cardRank(pickup) < 2 ? cards.filter((item) => item.id !== pickup.id).length : 0;
      const more = others > 0 && <small className="vehicle-more">{copy.carMoreCards(others)}</small>;
      const label = `${clock(pickup.wantedAt)} ${name}, ${place}`;
      // The live feed decides whether this card departs or only takes the pickup (F-10, 8.4 `primary_action`).
      const primary = model.primary(pickup);
      const startLabel = pickup.destination.confirmed ? copy.driveStart : copy.carCheckMap;
      if (received) {
        const from = nameOf(state, received.fromMemberId);
        view = (
          <div className="vehicle-main">
            <h2>{received.toMemberId ? copy.handoffReceived(from) : copy.handoffReceivedAll(from)}</h2>
            <p>{label}</p>
            {received.note && <p className="vehicle-note">“{received.note}”</p>}
            {rangeLine}{more}
          </div>
        );
        const declineButton = (
          <Button variant="secondary" disabled={busy} onClick={() => { void answerOffer(pickup, received.id, 'decline', from); }}>{copy.decline}</Button>
        );
        if (primary === 'start') {
          // Live: departing from a handoff card accepts it in the same transaction (8.3.1). Parked, "수락" also stays available.
          buttons = (
            <>
              <Button variant="amber" disabled={busy || (!vehicle.parked && !pickup.destination.confirmed)} onClick={() => { void start(pickup); }}>{startLabel}</Button>
              {vehicle.parked && (
                <Button variant="secondary" disabled={busy} onClick={() => { void answerOffer(pickup, received.id, 'accept', from); }}>{copy.acceptOffer}</Button>
              )}
              {declineButton}
            </>
          );
        } else {
          buttons = (
            <>
              <Button variant="amber" disabled={busy} onClick={() => { void answerOffer(pickup, received.id, 'accept', from); }}>{copy.acceptOffer}</Button>
              {declineButton}
            </>
          );
        }
      } else if (unanswered) {
        const to = unanswered.toMemberId ? nameOf(state, unanswered.toMemberId) : null;
        const title = unanswered.status === 'declined' ?
          to ? copy.handoffDeclined(to) : copy.handoffNobodyCan :
          to ? copy.handoffExpired(to) : copy.handoffNobody;
        view = (
          <div className="vehicle-alert">
            <CircleAlert aria-hidden="true" />
            <div className="vehicle-main">
              <h2>{title}</h2>
              <p>{copy.handoffStillPickup(clock(pickup.wantedAt), name, driver)}</p>
              {more}
            </div>
          </div>
        );
        buttons = <Button variant="amber" onClick={() => setSeenOffers((ids) => [...ids, unanswered.id])}>{copy.confirm}</Button>;
      } else {
        const future = pickup.status === 'open' && pickup.wantedAt > now + 15 * minute;
        const request = pickup.status === 'open';
        const early = pickup.readyAt != null;
        const home = !request && !early && !alert;
        const startButton = primary === 'accept' ? (
          <Button variant="amber" disabled={busy} onClick={() => { void accept(pickup); }}>{copy.acceptOffer}</Button>
        ) : (
          <Button variant="amber" disabled={busy || future || (!vehicle.parked && !pickup.destination.confirmed)} onClick={() => { void start(pickup); }}>
            {startLabel}
          </Button>
        );
        const cannotGoButton = !sentPending && (
          <Button variant="secondary" disabled={busy} onClick={() => { void operations.cannotGo(pickup); }}>{copy.declineRequest}</Button>
        );
        const requestTitle = model.routineOpen(pickup) ? copy.carRoutineOpen : copy.requestHeadline(name);
        const headline = early ? copy.earlyHeadline(name) : request ? requestTitle : alert === 'reminder' ? copy.carReminder :
          alert === 'not_departed' ? copy.carNotDeparted : `${clock(pickup.wantedAt)} ${name}`;
        inlineList = home && vehicle.parked;
        const details = (
          <div className="vehicle-main">
            {home && <p className="vehicle-kicker">{copy.nextPickup}</p>}
            <h2>{headline}</h2>
            {alert && !early ? (
              <p>{alert === 'reminder' ? label : `${name}, ${place}`}</p>
            ) : (
              <p><span>{place}</span>{request && pickup.destination.confirmed && <span>, {pickup.wantedAt > now + minute ? clock(pickup.wantedAt) : copy.now}</span>}</p>
            )}
            {!pickup.destination.confirmed ? (
              <p className="vehicle-error"><TriangleAlert aria-hidden="true" />{vehicle.parked ? copy.locationNotConfirmed : copy.carLocationPark}</p>
            ) : home ? <small>{copy.assignee} {nameOf(state, pickup.assigneeId)}</small> : rangeLine}
            {sentPending && (
              <small>{copy.handoffWaiting(sentPending.toMemberId ? nameOf(state, sentPending.toMemberId) : copy.handoffAll)}. {copy.handoffStill(driver)}</small>
            )}
            {more}
            {inlineList && (
              <div className="vehicle-actions">
                {startButton}
                <Button variant="secondary" onClick={() => setMode('list')}>{copy.carList}</Button>
              </div>
            )}
          </div>
        );
        view = home && vehicle.parked ? <div className="vehicle-split">{details}{carPanel}</div> : details;
        panelShown = home && vehicle.parked;
        if (!inlineList) buttons = <>{startButton}{!home && cannotGoButton}</>;
      }
    }
  }
  return (
    <main className="vehicle-layout">
      <section className="vehicle-screen">
        <header className="vehicle-header">
          <h1>{copy.app}</h1>
          <div>
            {!vehicle.online && <span className="vehicle-offline"><TriangleAlert size={18} aria-hidden="true" />{copy.offline}</span>}
            <span className="vehicle-demo-flag">{copy.demoValue}</span>
            <span>
              {vehicle.parked ? <ParkingSquare size={20} aria-hidden="true" /> : <CarFront size={21} aria-hidden="true" />}
              {vehicle.parked ? copy.parked : copy.driving}
            </span>
          </div>
        </header>
        <div className="vehicle-view" aria-live="polite">{view}</div>
        {buttons && <div className="vehicle-actions">{buttons}</div>}
      </section>
      <div className="vehicle-toolbar">
        {vehicle.parked && (
          <>
            {!operations.live && (
              <Button variant="outline" onClick={() => toggleMode('controls', showControls)}><SlidersHorizontal size={18} />{copy.demoTools}</Button>
            )}
            {paired && !inlineList && (
              <Button variant="outline" onClick={() => toggleMode('list', showList)}><CalendarDays size={18} />{copy.carList}</Button>
            )}
            {paired && !panelShown && (
              <Button variant="outline" aria-pressed={showSettings} onClick={() => toggleMode('settings', showSettings)}><Settings size={18} />{copy.settings}</Button>
            )}
          </>
        )}
        {!vehicle.parked && <Button variant="outline" onClick={() => patch({ parked: true })}><ParkingSquare size={18} />{copy.parked}</Button>}
        <span>{operations.live ? copy.carSimTitle : copy.carDemoTitle}</span>
      </div>
      {simulator}
    </main>
  );
}
