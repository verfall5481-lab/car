import { useState } from 'react';
import { Battery, CalendarDays, CarFront, Check, CircleAlert, Gauge, MapPin, ParkingSquare, SlidersHorizontal, TriangleAlert, UserRound } from 'lucide-react';
import { isActivePickup, requestRecipients, resolveDestination } from '@deriro/contracts';
import type { Actor, Pickup, PickupAction } from '@deriro/contracts';
import { clock, copy } from './copy.ts';
import { changed, destinationLabel, minute, nameOf, nearbyPlaces, rangeEstimate } from './demo-domain.ts';
import type { DemoState } from './demo-domain.ts';
import { Button, MapPreview, Row, Status, uid, useClock, useCommit, usePickupAction, useToast } from './ui.tsx';
import './vehicle.css';

export function VehicleScreen({ state }: { state: DemoState }) {
  const { vehicle } = state;
  const now = useClock(state);
  const toast = useToast();
  const commit = useCommit();
  const act = usePickupAction();
  const [mode, setMode] = useState<'home' | 'list' | 'controls'>('home');
  const [map, setMap] = useState<string | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [hidden, setHidden] = useState<string[]>([]);
  const [rangeSeen, setRangeSeen] = useState(false);
  const [manual, setManual] = useState<string | null>(null);
  const driver = nameOf(state, vehicle.currentDriverId);
  const actor: Actor = { kind: 'vehicle', id: vehicle.id, driverId: vehicle.currentDriverId ?? '', parked: vehicle.parked };
  const active = state.pickups.find((pickup) => pickup.id === vehicle.activePickupId);
  const visible = state.pickups.filter((pickup) => {
    if (hidden.includes(pickup.id)) return false;
    const recipient = requestRecipients(pickup, state.members, [vehicle]).vehicleIds.includes(vehicle.id);
    const assigned = pickup.assigneeId === vehicle.currentDriverId && pickup.vehicleId === vehicle.id;
    const offered = pickup.offer?.status === 'pending' && pickup.offer.fromMemberId !== vehicle.currentDriverId &&
      (!pickup.offer.toMemberId || pickup.offer.toMemberId === vehicle.currentDriverId) && !pickup.offer.declinedBy.includes(vehicle.currentDriverId ?? '');
    return assigned || recipient && (pickup.status === 'open' || offered);
  });
  const pending = visible.filter(isActivePickup).sort((a, b) => Number(a.source === 'routine') - Number(b.source === 'routine') || a.wantedAt - b.wantedAt);
  const pickup = active && !hidden.includes(active.id) ? active : pending[0] ?? visible.find((item) => item.status === 'completed' || item.status === 'cancelled');
  const showControls = mode === 'controls' && vehicle.parked;
  const showList = mode === 'list' && vehicle.parked;
  const mapPickup = vehicle.parked && map ? state.pickups.find((item) => item.id === map && isActivePickup(item)) : undefined;
  const switchPickup = vehicle.parked && next ? state.pickups.find((item) => item.id === next && isActivePickup(item)) : undefined;
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
  }
  function dismiss(item: Pickup) { setHidden((ids) => [...ids, item.id]); }
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
  const carPanel = <aside className="vehicle-meta">
    <strong><CarFront />{vehicle.name}</strong>
    <span><Battery />{copy.range(vehicle.rangeStale ? null : vehicle.range)}</span>
    <span><UserRound />{copy.driver} {driver}</span>
    <span className={`vehicle-connection${vehicle.online ? '' : ' vehicle-connection--offline'}`}>{vehicle.online ? copy.connected : copy.offline}</span>
    {!vehicle.online && <small>{copy.carOfflineHint}</small>}
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
  } else if (showList) {
    view = <div className="vehicle-control"><h2>{copy.carList}</h2>{pending.length ? pending.map((item) =>
      <Row key={item.id} onClick={vehicle.online ? () => { void start(item); } : undefined} icon={<time>{clock(item.wantedAt)}</time>} title={`${nameOf(state, item.requester.id)}, ${destinationLabel(state, item.destination)}`} caption={item.assigneeId ? `${copy.assignee} ${nameOf(state, item.assigneeId)}` : undefined} trailing={<Status pickup={item} />} />) : <p>{copy.noCarPickups}</p>}</div>;
    buttons = <Button variant="amber" onClick={() => setMode('home')}>{copy.back}</Button>;
  } else if (lowRange && range.requiredKm != null && vehicle.range != null && vehicle.parked && !active) {
    view = <div className="vehicle-alert vehicle-alert--range"><Gauge aria-hidden="true" /><div className="vehicle-main"><h2>{copy.rangeWarning(range.requiredKm)}</h2><p>{copy.rangeCurrent(vehicle.range)}</p><small>{copy.rangeEstimate} {copy.homeOrigin}</small></div></div>;
    buttons = <Button variant="amber" onClick={() => setRangeSeen(true)}>{copy.confirm}</Button>;
  } else if (!pickup) {
    view = <div className="vehicle-split"><div className="vehicle-main vehicle-empty"><CalendarDays aria-hidden="true" /><h2>{copy.noCarPickups}</h2></div>{vehicle.parked && carPanel}</div>;
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
      const future = pickup.status === 'open' && pickup.wantedAt > now + 15 * minute;
      const request = pickup.status === 'open';
      const early = pickup.readyAt != null;
      const home = !request && !early;
      const estimate = rangeEstimate(state, [pickup], vehicle);
      const startButton = <Button variant="amber" disabled={!vehicle.online || future || (!vehicle.parked && !pickup.destination.confirmed)} onClick={() => { void start(pickup); }}>{pickup.destination.confirmed ? copy.driveStart : copy.carCheckMap}</Button>;
      inlineList = home && vehicle.parked;
      const details = <div className="vehicle-main">
        {home && <p className="vehicle-kicker">{copy.nextPickup}</p>}
        <h2>{early ? copy.earlyHeadline(name) : request ? copy.requestHeadline(name) : `${clock(pickup.wantedAt)} ${name}`}</h2>
        <p><span>{place}</span>{request && pickup.destination.confirmed && <span>, {pickup.wantedAt > now + minute ? clock(pickup.wantedAt) : copy.now}</span>}</p>
        {!pickup.destination.confirmed ? <p className="vehicle-error"><TriangleAlert aria-hidden="true" />{vehicle.parked ? copy.locationNotConfirmed : copy.carLocationPark}</p> :
          home ? <small>{copy.assignee} {nameOf(state, pickup.assigneeId)}</small> :
          estimate.requiredKm != null && <small>{copy.rangeNeed(estimate.requiredKm)}, {copy.range(vehicle.rangeStale ? null : vehicle.range)}</small>}
        {inlineList && <div className="vehicle-actions">{startButton}<Button variant="secondary" onClick={() => setMode('list')}>{copy.carList}</Button></div>}
      </div>;
      view = home && vehicle.parked ? <div className="vehicle-split">{details}{carPanel}</div> : details;
      if (!inlineList) buttons = <>{startButton}{request && <Button variant="secondary" onClick={() => dismiss(pickup)}>{copy.declineRequest}</Button>}</>;
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
      {vehicle.parked && <><Button variant="outline" onClick={() => { setMap(null); setNext(null); setMode(showControls ? 'home' : 'controls'); }}><SlidersHorizontal size={18} />{copy.demoTools}</Button>{!inlineList && <Button variant="outline" onClick={() => { setMap(null); setNext(null); setMode(showList ? 'home' : 'list'); }}><CalendarDays size={18} />{copy.carList}</Button>}</>}
      {!vehicle.parked && <Button variant="outline" onClick={() => patch({ parked: true })}><ParkingSquare size={18} />{copy.parked}</Button>}
      <span>{copy.carDemoTitle}</span>
    </div>
  </main>;
}
