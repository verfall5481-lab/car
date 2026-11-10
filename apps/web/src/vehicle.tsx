import { useEffect, useState } from 'react';
import { Battery, CalendarDays, CarFront, Check, CircleAlert, Clock3, Gauge, MapPin, ParkingSquare, Settings, SlidersHorizontal, TriangleAlert, UserRound } from 'lucide-react';
import QRCode from 'qrcode';
import { isActivePickup, requestRecipients, resolveDestination } from '@deriro/contracts';
import type { Actor, Pickup, PickupAction } from '@deriro/contracts';
import { clock, copy } from './copy.ts';
import { changed, destinationLabel, formatPairCode, minute, nameOf, nearbyPlaces, rangeEstimate, renewPairCode, setVehicleDriver, unpairVehicle, vehiclePaired } from './demo-domain.ts';
import type { DemoState, PairCode } from './demo-domain.ts';
import { Button, MapPreview, Row, Status, uid, useClock, useCommit, usePickupAction, useToast } from './ui.tsx';
import './vehicle.css';

function VehicleQr({ href }: { href: string }) {
  const [image, setImage] = useState<{ href: string; data: string }>();
  useEffect(() => {
    let active = true;
    void QRCode.toDataURL(href, { width: 220, margin: 2, errorCorrectionLevel: 'M' }).then((data) => { if (active) setImage({ href, data }); }).catch(() => {});
    return () => { active = false; };
  }, [href]);
  return <figure className="vehicle-qr">
    {image?.href === href ? <img src={image.data} width="150" height="150" alt={copy.demoQrLabel} /> : <span className="vehicle-qr-blank" />}
    <figcaption>{copy.demoQrLabel}</figcaption>
  </figure>;
}

/** V-01: the car shows a short-lived code; a family phone confirms it on P-14. */
function VehiclePairing({ pairing, now }: { pairing: PairCode | null | undefined; now: number }) {
  const seconds = pairing ? Math.max(0, Math.floor((pairing.expiresAt - now) / 1000)) : 0;
  const href = pairing ? new URL(`/p/vehicles/pair?code=${pairing.code}`, window.location.origin).href : '';
  return <div className="vehicle-pair">
    <div className="vehicle-main">
      <h2>{copy.carPairTitle}</h2>
      <ol className="vehicle-steps">{copy.carPairSteps.map((step) => <li key={step}>{step}</li>)}</ol>
      {seconds > 0 && pairing ? <p className="vehicle-pair-code"><span>{copy.carPairCode}</span><strong>{formatPairCode(pairing.code)}</strong></p> :
        <p className="vehicle-error"><Clock3 aria-hidden="true" />{copy.carPairExpired}</p>}
    </div>
    {seconds > 0 && <div className="vehicle-pair-qr"><VehicleQr href={href} /><span><Clock3 size={16} aria-hidden="true" />{copy.carPairRemaining(seconds)}</span></div>}
  </div>;
}

export function VehicleScreen({ state }: { state: DemoState }) {
  const { vehicle } = state;
  const paired = vehiclePaired(vehicle);
  const now = useClock(state);
  const toast = useToast();
  const commit = useCommit();
  const act = usePickupAction();
  const [mode, setMode] = useState<'home' | 'list' | 'controls' | 'settings' | 'unpair'>('home');
  const [map, setMap] = useState<string | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [hidden, setHidden] = useState<string[]>([]);
  const [rangeSeen, setRangeSeen] = useState(false);
  const [manual, setManual] = useState<string | null>(null);
  const [seenOffers, setSeenOffers] = useState<string[]>([]);
  const driverId = vehicle.currentDriverId ?? '';
  const driver = nameOf(state, vehicle.currentDriverId);
  const actor: Actor = { kind: 'vehicle', id: vehicle.id, driverId, parked: vehicle.parked };
  const active = state.pickups.find((pickup) => pickup.id === vehicle.activePickupId);
  // Same as the server feed's `own`: the current driver's pickup that has no car yet or already uses this car.
  const mine = (pickup: Pickup) => Boolean(driverId) && pickup.assigneeId === driverId && (pickup.vehicleId == null || pickup.vehicleId === vehicle.id);
  // F-12: an open request this driver declined stays closed on this car only.
  const declinedHere = (pickup: Pickup) => state.history.some((item) => item.pickupId === pickup.id && item.event === 'request_declined' && item.actor === driverId) ||
    pickup.offer?.status === 'pending' && pickup.offer.declinedBy.includes(driverId);
  // V-03 부탁 카드: a pending handoff from another member that this driver may answer.
  const receivedOffer = (pickup: Pickup) => {
    const offer = pickup.offer;
    return offer?.status === 'pending' && offer.fromMemberId != null && offer.fromMemberId !== driverId &&
      (!offer.toMemberId || offer.toMemberId === driverId) && !offer.declinedBy.includes(driverId) ? offer : null;
  };
  // V-03 "내가 보낸 부탁이 만료됨": the driver still owns the pickup after nobody accepted.
  const unansweredOffer = (pickup: Pickup) => {
    const offer = pickup.offer;
    return mine(pickup) && pickup.status === 'assigned' && offer && offer.fromMemberId === driverId &&
      (offer.status === 'expired' || offer.status === 'declined') && !seenOffers.includes(offer.id) ? offer : null;
  };
  // F-15: routine reminder and not-departed re-alert for the assigned car.
  const departureAlert = (pickup: Pickup): 'reminder' | 'not_departed' | null => {
    if (!mine(pickup) || pickup.status !== 'assigned') return null;
    if (pickup.source === 'routine') {
      const before = state.routines.find((routine) => routine.id === state.occurrences[pickup.id])?.before ?? 20;
      return now >= pickup.wantedAt + 5 * minute ? 'not_departed' : now >= pickup.wantedAt - before * minute ? 'reminder' : null;
    }
    return now >= Math.max(pickup.wantedAt, pickup.acceptedAt ?? pickup.wantedAt) + 10 * minute ? 'not_departed' : null;
  };
  const cardRank = (pickup: Pickup) => pickup.status === 'open' || receivedOffer(pickup) || unansweredOffer(pickup) ? 0 :
    pickup.readyAt != null && pickup.status === 'assigned' || departureAlert(pickup) ? 1 : 2;
  const visible = state.pickups.filter((pickup) => {
    if (hidden.includes(pickup.id)) return false;
    if (mine(pickup)) return true;
    if (!requestRecipients(pickup, state.members, [vehicle]).vehicleIds.includes(vehicle.id)) return false;
    return pickup.status === 'open' ? !declinedHere(pickup) : Boolean(receivedOffer(pickup));
  });
  const pending = visible.filter(isActivePickup).sort((a, b) => cardRank(a) - cardRank(b) || Number(a.source === 'routine') - Number(b.source === 'routine') || a.wantedAt - b.wantedAt);
  const cards = pending.filter((item) => cardRank(item) < 2);
  // V-03 cancelled_urgent: a trip this car had started and that was cancelled in the last 30 minutes shows before any other card.
  const urgentCancel = visible.find((item) => item.status === 'cancelled' && item.vehicleId === vehicle.id && item.enRouteAt != null &&
    state.history.some((event) => event.pickupId === item.id && event.event === 'cancelled' && event.at >= now - 30 * minute));
  const pickup = urgentCancel ?? (active && !hidden.includes(active.id) ? active : pending[0] ?? visible.find((item) => item.status === 'completed' || item.status === 'cancelled'));
  const showControls = mode === 'controls' && vehicle.parked;
  const showList = mode === 'list' && vehicle.parked && paired;
  const showSettings = (mode === 'settings' || mode === 'unpair') && vehicle.parked && paired;
  const mapPickup = paired && vehicle.parked && map ? state.pickups.find((item) => item.id === map && isActivePickup(item)) : undefined;
  const switchPickup = paired && vehicle.parked && next ? state.pickups.find((item) => item.id === next && isActivePickup(item)) : undefined;
  const drivers = state.members.filter((person) => person.canDrive && person.leftAt == null);
  async function chooseDriver(id: string) {
    await commit((current) => setVehicleDriver(current, id), copy.carDriverChanged(nameOf(state, id)));
  }
  async function unpair() {
    const result = await commit((current, at) => unpairVehicle(current, at), copy.carUnpaired);
    if (result.ok) { setMode('home'); setHidden([]); setSeenOffers([]); }
  }
  const range = rangeEstimate(state, pending.filter((item) => item.vehicleId === vehicle.id && item.status === 'assigned' && item.wantedAt >= now && item.wantedAt <= now + 1440 * minute), vehicle);
  const lowRange = range.verdict === 'low' && !rangeSeen;
  function patch(fields: Partial<DemoState['vehicle']>) {
    void commit((current) => changed({ ...current, vehicle: { ...current.vehicle, ...fields } }));
  }
  function doAction(item: Pickup, action: PickupAction, message?: string) { return act(item, actor, action, message); }
  async function start(item: Pickup, confirmedSwitch = false) {
    if (!item.destination.confirmed) { if (vehicle.parked) setMap(item.id); return; }
    if (active && active.id !== item.id && !confirmedSwitch) { if (vehicle.parked) setNext(item.id); return; }
    setMode('home');
    setManual(null);
    const result = await act(item, actor, { type: 'vehicle_start', expectedVersion: item.version, sessionId: uid(), actionId: uid(), offerId: item.offer?.id }, undefined, { confirmedSwitch });
    if (result.ok && !result.state.vehicle.navError) toast(copy.openNavDemo);
    else if (!result.ok) closeIfTaken(item, result.state);
  }
  function dismiss(item: Pickup) { setHidden((ids) => [...ids, item.id]); }
  // V-03: when another member took the pickup first, say who and close the card after 3 seconds.
  function closeIfTaken(item: Pickup, latestState: DemoState) {
    const latest = latestState.pickups.find(({ id }) => id === item.id);
    if (!latest?.assigneeId || latest.assigneeId === driverId) return;
    toast(copy.carTakenBy(nameOf(latestState, latest.assigneeId)));
    window.setTimeout(() => dismiss(item), 3000);
  }
  async function answerOffer(item: Pickup, offerId: string, response: 'accept' | 'decline', from: string) {
    const result = await doAction(item, { type: 'respond_offer', expectedVersion: item.version, offerId, response }, response === 'decline' ? copy.carDeclinedTo(from) : undefined);
    if (!result.ok) closeIfTaken(item, result.state);
  }
  // F-12 "못 가요": an open request records this driver's refusal; an assigned pickup asks everyone while staying assigned.
  async function cannotGo(item: Pickup) {
    const offer = item.offer;
    if (item.status === 'open') {
      if (offer?.status === 'pending' && offer.fromMemberId == null && !offer.declinedBy.includes(driverId)) {
        await doAction(item, { type: 'respond_offer', expectedVersion: item.version, offerId: offer.id, response: 'decline' }, copy.carDeclinedOthers);
        return;
      }
      await commit((current, at) => changed({ ...current, history: [{ pickupId: item.id, at, event: 'request_declined', actor: driverId }, ...current.history] }), copy.carDeclinedOthers);
      return;
    }
    await doAction(item, { type: 'offer', expectedVersion: item.version, offerId: uid() }, copy.carDeclinedOthers);
  }
  async function confirmLocation(item: Pickup, placeId?: string) {
    const destination = placeId ? resolveDestination(item.familyId, { source: 'saved_place', placeId }, state.places) : { ...item.destination, confirmed: true };
    if (!destination) return;
    const result = await doAction(item, { type: 'confirm_location', expectedVersion: item.version, destination });
    if (result.ok) setMap(null);
  }
  function arrivalCallback(previous: boolean) {
    if (!active?.navigation) return;
    void doAction(active, { type: 'arrive', source: 'nav_callback', sessionId: previous ? 'old-demo-navigation' : active.navigation.sessionId,
      destinationRevision: active.navigation.destinationRevision }).then((result) => { if (result.ok && result.ignored) toast(copy.carIgnoredCallback); });
  }

  let view;
  let buttons;
  let inlineList = false;
  let panelShown = false;
  const carPanel = <aside className="vehicle-meta">
    <strong><CarFront />{vehicle.name}</strong>
    <span><Battery />{copy.range(vehicle.rangeStale ? null : vehicle.range)}</span>
    <span><UserRound />{copy.driver} {driver}</span>
    <span className={`vehicle-connection${vehicle.online ? '' : ' vehicle-connection--offline'}`}>{vehicle.online ? copy.connected : copy.offline}</span>
    {!vehicle.online && <small>{copy.carOfflineHint}</small>}
    <button type="button" className="vehicle-settings-link" onClick={() => setMode('settings')}><Settings aria-hidden="true" />{copy.settings}</button>
  </aside>;
  if (mapPickup) {
    view = <div className="vehicle-location">
      <MapPreview coords={mapPickup.destination} uncertain />
      <div className="vehicle-main"><h2>{copy.confirmLocation}</h2><p>{mapPickup.destination.label}</p><small>{copy.mapAcc}</small>
        <div className="vehicle-nearby"><h3>{copy.nearbyPlaces}</h3>
          {nearbyPlaces(state, mapPickup.destination).map(({ place, distance }) =>
            <Button key={place.id} variant="secondary" disabled={!vehicle.online} onClick={() => { void confirmLocation(mapPickup, place.id); }}>
              <MapPin size={18} />{place.label}<small>{copy.distance(distance)}</small>
            </Button>)}
        </div>
      </div>
    </div>;
    buttons = <><Button variant="amber" disabled={!vehicle.online} onClick={() => { void confirmLocation(mapPickup); }}>{copy.confirmHere}</Button><Button variant="secondary" onClick={() => setMap(null)}>{copy.back}</Button></>;
  } else if (switchPickup) {
    view = <div className="vehicle-main"><h2>{copy.navSwitch(nameOf(state, switchPickup.requester.id))}</h2></div>;
    buttons = <><Button variant="amber" disabled={!vehicle.online} onClick={() => { void start(switchPickup, true); setNext(null); }}>{copy.navChange}</Button><Button variant="secondary" onClick={() => setNext(null)}>{copy.cancelNo}</Button></>;
  } else if (showControls) {
    view = <div className="vehicle-control"><h2>{copy.demoTools}</h2>
      <label className="vehicle-option"><span><Gauge size={22} />{copy.rangeTitle}</span><output>{vehicle.range ?? 0}km</output><input aria-label={copy.rangeTitle} type="range" min="0" max="150" step="1" value={vehicle.range ?? 0} onChange={(event) => { patch({ range: Number(event.target.value) }); setRangeSeen(false); }} /></label>
      <div className="vehicle-option"><span>{copy.driveMode}</span><div className="actions"><Button variant="amber" aria-pressed={vehicle.parked} onClick={() => patch({ parked: true })}>{copy.parked}</Button><Button variant="secondary" onClick={() => { patch({ parked: false }); setMode('home'); }}>{copy.driving}</Button></div></div>
      <div className="vehicle-option"><span>{copy.network}</span><div className="actions"><Button variant={vehicle.online ? 'amber' : 'secondary'} aria-pressed={vehicle.online} onClick={() => patch({ online: true })}>{copy.connected}</Button><Button variant={!vehicle.online ? 'amber' : 'secondary'} aria-pressed={!vehicle.online} onClick={() => patch({ online: false })}>{copy.offline}</Button></div></div>
      <div className="vehicle-option"><span>{copy.navState}</span><div className="actions"><Button variant={!vehicle.navFails ? 'amber' : 'secondary'} aria-pressed={!vehicle.navFails} onClick={() => patch({ navFails: false })}>{copy.navSuccess}</Button><Button variant={vehicle.navFails ? 'amber' : 'secondary'} aria-pressed={vehicle.navFails} onClick={() => patch({ navFails: true })}>{copy.navFail}</Button></div></div>
      {active?.navigation && <div className="vehicle-callbacks"><Button variant="secondary" disabled={!vehicle.online} onClick={() => arrivalCallback(false)}>{copy.carCurrentCallback}</Button><Button variant="secondary" disabled={!vehicle.online} onClick={() => arrivalCallback(true)}>{copy.carPreviousCallback}</Button></div>}
    </div>;
    buttons = <Button variant="amber" onClick={() => setMode('home')}>{copy.back}</Button>;
  } else if (!paired) {
    view = vehicle.parked ? <VehiclePairing pairing={vehicle.pairing} now={now} /> :
      <div className="vehicle-main vehicle-center vehicle-empty"><CarFront aria-hidden="true" /><h2>{copy.carStopToPair}</h2></div>;
    const expired = !vehicle.pairing || vehicle.pairing.expiresAt <= now;
    if (vehicle.parked) buttons = <Button variant={expired ? 'amber' : 'secondary'} onClick={() => { void commit((current, at) => renewPairCode(current, at)); }}>{copy.newCode}</Button>;
  } else if (showSettings && mode === 'unpair') {
    view = <div className="vehicle-alert"><TriangleAlert aria-hidden="true" /><div className="vehicle-main"><h2>{copy.carDisconnectQuestion}</h2><p>{copy.carUnpairDesc}</p></div></div>;
    buttons = <><Button variant="amber" disabled={!vehicle.online} onClick={() => { void unpair(); }}>{copy.disconnect}</Button><Button variant="secondary" onClick={() => setMode('settings')}>{copy.back}</Button></>;
  } else if (showSettings) {
    // V-09: who is driving decides which cards are "mine"; changing it is a parked-only action.
    view = <div className="vehicle-control vehicle-settings"><h2>{copy.currentDriver}</h2>
      <div className="vehicle-drivers" role="group" aria-label={copy.currentDriver}>{drivers.map((person) =>
        <Button key={person.id} variant={person.id === driverId ? 'amber' : 'secondary'} aria-pressed={person.id === driverId} disabled={!vehicle.online || Boolean(vehicle.activePickupId)} onClick={() => { if (person.id !== driverId) void chooseDriver(person.id); }}>{person.name}</Button>)}</div>
      {vehicle.activePickupId && <small className="vehicle-hint">{copy.carDriverBusy}</small>}
      <dl className="vehicle-facts"><div><dt>{copy.carNickname}</dt><dd>{vehicle.name}</dd></div><div><dt>{copy.carConnectedFamily}</dt><dd>{state.familyName}</dd></div></dl>
    </div>;
    buttons = <><Button variant="amber" onClick={() => setMode('home')}>{copy.back}</Button><Button variant="secondary" className="vehicle-danger" disabled={!vehicle.online} onClick={() => setMode('unpair')}>{copy.disconnect}</Button></>;
  } else if (showList) {
    view = <div className="vehicle-control"><h2>{copy.carList}</h2>{pending.length ? pending.map((item) =>
      <Row key={item.id} onClick={vehicle.online ? () => { void start(item); } : undefined} icon={<time>{clock(item.wantedAt)}</time>} title={`${nameOf(state, item.requester.id)}, ${destinationLabel(state, item.destination)}`} caption={item.assigneeId ? `${copy.assignee} ${nameOf(state, item.assigneeId)}` : undefined} trailing={<Status pickup={item} />} />) : <p>{copy.noCarPickups}</p>}</div>;
    buttons = <Button variant="amber" onClick={() => setMode('home')}>{copy.back}</Button>;
  } else if (lowRange && range.requiredKm != null && vehicle.range != null && vehicle.parked && !active) {
    view = <div className="vehicle-alert vehicle-alert--range"><Gauge aria-hidden="true" /><div className="vehicle-main"><h2>{copy.rangeWarning(range.requiredKm)}</h2><p>{copy.rangeCurrent(vehicle.range)}</p><small>{copy.rangeEstimate} {copy.homeOrigin}</small></div></div>;
    buttons = <Button variant="amber" onClick={() => setRangeSeen(true)}>{copy.confirm}</Button>;
  } else if (!pickup) {
    view = <div className="vehicle-split"><div className="vehicle-main vehicle-empty"><CalendarDays aria-hidden="true" /><h2>{copy.noCarPickups}</h2></div>{vehicle.parked && carPanel}</div>;
    panelShown = vehicle.parked;
  } else {
    const name = nameOf(state, pickup.requester.id);
    const place = destinationLabel(state, pickup.destination);
    if (pickup.status === 'completed') {
      view = <div className="vehicle-main vehicle-center"><span className="vehicle-success"><Check aria-hidden="true" /></span><h2>{copy.carCompleted}</h2><p>{name}, {place}</p></div>;
      buttons = <Button variant="amber" onClick={() => dismiss(pickup)}>{copy.confirm}</Button>;
    } else if (pickup.status === 'cancelled') {
      view = <div className="vehicle-alert"><TriangleAlert aria-hidden="true" /><div className="vehicle-main"><h2>{copy.carCancelled(name)}</h2><p>{copy.carCancelDesc}</p></div></div>;
      buttons = <Button variant="amber" onClick={() => dismiss(pickup)}>{copy.confirm}</Button>;
    } else if (pickup.status === 'arrived') {
      const late = pickup.arrivedAt != null && now >= pickup.arrivedAt + 30 * minute;
      const notMet = pickup.notMetAt != null;
      view = notMet ? <div className="vehicle-alert"><CircleAlert aria-hidden="true" /><div className="vehicle-main"><h2>{copy.notMetHeadline(name)}</h2><p>{place}. {copy.carNotMetHint}</p></div></div> :
        <div className="vehicle-split vehicle-split--arrival"><div className="vehicle-main">
          <h2>{late ? copy.boardingCheck(name) : copy.arrival}</h2><p>{late ? copy.boardingLate : copy.carNotify(name)}</p>
          {!vehicle.parked && <small>{copy.carParkToBoard}</small>}
        </div>{vehicle.parked && !late && <aside className="vehicle-meta"><strong className="vehicle-arrived">{copy.statuses.arrived}</strong><span>{copy.parked}</span></aside>}</div>;
      buttons = <Button variant="amber" disabled={!vehicle.online || !vehicle.parked} onClick={() => { void doAction(pickup, { type: 'board', expectedVersion: pickup.version }); }}>{copy.boarded}</Button>;
    } else if (pickup.status === 'en_route') {
      const failed = vehicle.navError && manual !== pickup.id;
      view = <div className="vehicle-main"><h2>{copy.driveTo(name)}</h2><p>{place}</p>{failed && <p className="vehicle-error"><TriangleAlert aria-hidden="true" />{copy.failNav}</p>}</div>;
      buttons = failed ? <><Button variant="amber" disabled={!vehicle.online} onClick={() => { void start(pickup); }}>{copy.navRetry}</Button><Button variant="secondary" onClick={() => setManual(pickup.id)}>{copy.navManual}</Button></> :
        <><Button variant="amber" disabled={!vehicle.online} onClick={() => { void doAction(pickup, { type: 'arrive', source: 'manual', expectedVersion: pickup.version }); }}>{copy.arrival}</Button>
        <Button variant="secondary" disabled={!vehicle.online} onClick={() => { void start(pickup); }}>{copy.reopenNav}</Button></>;
    } else {
      const received = receivedOffer(pickup);
      const unanswered = unansweredOffer(pickup);
      const alert = departureAlert(pickup);
      const sentPending = pickup.offer?.status === 'pending' && pickup.offer.fromMemberId === driverId ? pickup.offer : null;
      const estimate = rangeEstimate(state, [pickup], vehicle);
      const rangeLine = estimate.requiredKm != null && <small>{copy.rangeNeed(estimate.requiredKm)}, {copy.range(vehicle.rangeStale ? null : vehicle.range)}</small>;
      const others = cardRank(pickup) < 2 ? cards.filter((item) => item.id !== pickup.id).length : 0;
      const more = others > 0 && <small className="vehicle-more">{copy.carMoreCards(others)}</small>;
      const label = `${clock(pickup.wantedAt)} ${name}, ${place}`;
      if (received) {
        const from = nameOf(state, received.fromMemberId);
        view = <div className="vehicle-main">
          <h2>{received.toMemberId ? copy.handoffReceived(from) : copy.handoffReceivedAll(from)}</h2>
          <p>{label}</p>
          {received.note && <p className="vehicle-note">“{received.note}”</p>}
          {rangeLine}{more}
        </div>;
        buttons = <><Button variant="amber" disabled={!vehicle.online} onClick={() => { void answerOffer(pickup, received.id, 'accept', from); }}>{copy.acceptOffer}</Button>
          <Button variant="secondary" disabled={!vehicle.online} onClick={() => { void answerOffer(pickup, received.id, 'decline', from); }}>{copy.decline}</Button></>;
      } else if (unanswered) {
        const to = unanswered.toMemberId ? nameOf(state, unanswered.toMemberId) : null;
        const title = unanswered.status === 'declined' ? to ? copy.handoffDeclined(to) : copy.handoffNobodyCan : to ? copy.handoffExpired(to) : copy.handoffNobody;
        view = <div className="vehicle-alert"><CircleAlert aria-hidden="true" /><div className="vehicle-main"><h2>{title}</h2><p>{copy.handoffStillPickup(clock(pickup.wantedAt), name, driver)}</p>{more}</div></div>;
        buttons = <Button variant="amber" onClick={() => setSeenOffers((ids) => [...ids, unanswered.id])}>{copy.confirm}</Button>;
      } else {
        const future = pickup.status === 'open' && pickup.wantedAt > now + 15 * minute;
        const request = pickup.status === 'open';
        const early = pickup.readyAt != null;
        const home = !request && !early && !alert;
        const startButton = <Button variant="amber" disabled={!vehicle.online || future || (!vehicle.parked && !pickup.destination.confirmed)} onClick={() => { void start(pickup); }}>{pickup.destination.confirmed ? copy.driveStart : copy.carCheckMap}</Button>;
        const cannotGoButton = !sentPending && <Button variant="secondary" disabled={!vehicle.online} onClick={() => { void cannotGo(pickup); }}>{copy.declineRequest}</Button>;
        const headline = early ? copy.earlyHeadline(name) : request ? copy.requestHeadline(name) : alert === 'reminder' ? copy.carReminder :
          alert === 'not_departed' ? copy.carNotDeparted : `${clock(pickup.wantedAt)} ${name}`;
        inlineList = home && vehicle.parked;
        const details = <div className="vehicle-main">
          {home && <p className="vehicle-kicker">{copy.nextPickup}</p>}
          <h2>{headline}</h2>
          {alert && !early ? <p>{alert === 'reminder' ? label : `${name}, ${place}`}</p> :
            <p><span>{place}</span>{request && pickup.destination.confirmed && <span>, {pickup.wantedAt > now + minute ? clock(pickup.wantedAt) : copy.now}</span>}</p>}
          {!pickup.destination.confirmed ? <p className="vehicle-error"><TriangleAlert aria-hidden="true" />{vehicle.parked ? copy.locationNotConfirmed : copy.carLocationPark}</p> :
            home ? <small>{copy.assignee} {nameOf(state, pickup.assigneeId)}</small> : rangeLine}
          {sentPending && <small>{copy.handoffWaiting(sentPending.toMemberId ? nameOf(state, sentPending.toMemberId) : copy.handoffAll)}. {copy.handoffStill(driver)}</small>}
          {more}
          {inlineList && <div className="vehicle-actions">{startButton}<Button variant="secondary" onClick={() => setMode('list')}>{copy.carList}</Button></div>}
        </div>;
        view = home && vehicle.parked ? <div className="vehicle-split">{details}{carPanel}</div> : details;
        panelShown = home && vehicle.parked;
        if (!inlineList) buttons = <>{startButton}{!home && cannotGoButton}</>;
      }
    }
  }
  return <main className="vehicle-layout">
    <section className="vehicle-screen">
      <header className="vehicle-header"><h1>{copy.app}</h1><div>
        {!vehicle.online && <span className="vehicle-offline"><TriangleAlert size={18} aria-hidden="true" />{copy.offline}</span>}
        <span className="vehicle-demo-flag">{copy.demoValue}</span>
        <span>{vehicle.parked ? <ParkingSquare size={20} aria-hidden="true" /> : <CarFront size={21} aria-hidden="true" />}{vehicle.parked ? copy.parked : copy.driving}</span>
      </div></header>
      <div className="vehicle-view" aria-live="polite">{view}</div>
      {buttons && <div className="vehicle-actions">{buttons}</div>}
    </section>
    <div className="vehicle-toolbar">
      {vehicle.parked && <><Button variant="outline" onClick={() => { setMap(null); setNext(null); setMode(showControls ? 'home' : 'controls'); }}><SlidersHorizontal size={18} />{copy.demoTools}</Button>
        {paired && !inlineList && <Button variant="outline" onClick={() => { setMap(null); setNext(null); setMode(showList ? 'home' : 'list'); }}><CalendarDays size={18} />{copy.carList}</Button>}
        {paired && !panelShown && <Button variant="outline" aria-pressed={showSettings} onClick={() => { setMap(null); setNext(null); setMode(showSettings ? 'home' : 'settings'); }}><Settings size={18} />{copy.settings}</Button>}</>}
      {!vehicle.parked && <Button variant="outline" onClick={() => patch({ parked: true })}><ParkingSquare size={18} />{copy.parked}</Button>}
      <span>{copy.carDemoTitle}</span>
    </div>
  </main>;
}
