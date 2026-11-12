import { useState } from 'react';
import { Bell, CalendarDays, CarFront, Check, ChevronDown, ChevronRight, CircleAlert, CircleCheck, Clock3, GraduationCap, Info, MapPin, Phone, Smartphone, UserRound } from 'lucide-react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { isActivePickup, requestRecipients, resolveDestination } from '@deriro/contracts';
import type { Actor, Coordinates, Destination, Pickup, PickupAction } from '@deriro/contracts';
import { clock, copy, dateLabel } from './copy.ts';
import { demoRoutinesToday, destinationLabel, familyId, minute, nameOf, nearbyPlaces, rangeEstimate, unavailableFor } from './demo-domain.ts';
import type { DemoState, History, Person } from './demo-domain.ts';
import { fallbackByName, fallbackKey, guardianOffer, isNobodyAvailable, noDriverSections } from './guardian-view.ts';
import type { FallbackStage } from './guardian-view.ts';
import { NoDriverSheet, UnavailableLink } from './no-driver.tsx';
import { declarationTitle } from './rider-view.ts';
import { Badge, Button, eventText, HeaderBell, MapPreview, MobileHeader, Placeholder, RadioLine, Row, Sheet, Status, statusLabel, StepCheck, uid, useClock, useCommit, usePickupAction, usePickupOperations, useToast } from './ui.tsx';
import './guardian.css';

const pickupPath = (pickup: Pickup) => `/p/pickups/${pickup.id}`;

type CardProps = { state: DemoState; member: Person; pickup: Pickup };
type SheetKind = 'car' | 'cancel' | 'takeover' | 'skip' | 'undo' | 'no_driver';

/** The requester's phone for a `tel:` link: live data only; the demo calls nobody and explains so (24.5). */
function requesterPhone(state: DemoState, pickup: Pickup) {
  const people: readonly { id: string; phone?: string }[] = pickup.requester.kind === 'rider' ? state.riders : state.members;
  return state.live ? people.find((person) => person.id === pickup.requester.id)?.phone : undefined;
}

function CallRequester({ state, pickup, variant = 'primary' }: { state: DemoState; pickup: Pickup; variant?: 'primary' | 'secondary' }) {
  const toast = useToast();
  const phone = requesterPhone(state, pickup);
  const label = copy.call(nameOf(state, pickup.requester.id));
  if (phone) return <a className={`button button--${variant}`} href={`tel:${phone}`}><Phone size={19} />{label}</a>;
  return state.live ? null : <Button variant={variant} onClick={() => toast(copy.callDemo)}><Phone size={19} />{label}</Button>;
}

/**
 * `pair`: the "갈 사람 없음" and "내일" cards (24.5), whose two buttons are "내가 갈게" and "못 간다고 알리기".
 */
function PickupActions({ state, member, pickup, compact = false, showOfferResult = false, acknowledge, pair = false }: CardProps & { compact?: boolean; showOfferResult?: boolean; acknowledge?: () => void; pair?: boolean }) {
  const [open, setOpen] = useState<SheetKind | null>(null);
  const act = usePickupAction();
  const busy = usePickupOperations()?.pending;
  const now = useClock(state);
  const navigate = useNavigate();
  const actor: Actor = { kind: 'member', id: member.id };
  const assignee = pickup.assigneeId === member.id;
  const fromSelf = pickup.requester.kind === 'member' && pickup.requester.id === member.id;
  const eligible = requestRecipients(pickup, state.members).memberIds.includes(member.id);
  // A family-wide offer (no sender) keeps "내가 갈게"; only a handoff to me is answered with "수락" (P-04).
  const { sent, received, canAccept } = guardianOffer(pickup, member.id, eligible);
  const version = pickup.version;
  const change = (action: PickupAction) => act(pickup, actor, action);
  const openPage = (page: 'handoff' | 'location') => navigate(`${pickupPath(pickup)}/${page}`, { state: { returnToPickupHome: compact } });
  const depart = () => { if (!pickup.destination.confirmed) openPage('location'); else void change({ type: 'depart', expectedVersion: version }); };
  const handoff = <Button variant={compact ? 'secondary' : 'plain'} onClick={() => openPage('handoff')}>{copy.handoff}</Button>;
  // 24.3 #20, #21: any guardian but the requester on an open pickup; only the assignee once it is assigned.
  const canDeclare = !fromSelf && (pickup.status === 'open' || (pickup.status === 'assigned' && assignee));
  const declare = (variant: 'secondary' | 'plain') => <Button variant={variant} disabled={busy} onClick={() => setOpen('no_driver')}>{copy.declareNoDriver}</Button>;
  const offerResult = showOfferResult && acknowledge && assignee && pickup.status === 'assigned';
  let buttons = null;

  if (offerResult) {
    buttons = <><Button onClick={acknowledge}>{copy.confirm}</Button><Button variant="secondary" onClick={() => openPage('handoff')}>{copy.handoffAgain}</Button></>;
  } else if (pair && canDeclare) {
    buttons = <>{canAccept && <Button disabled={busy} onClick={() => setOpen('car')}>{copy.accept}</Button>}{declare('secondary')}</>;
  } else if (canAccept) {
    buttons = <><Button disabled={busy} onClick={() => setOpen('car')}>{received ? copy.acceptOffer : copy.accept}</Button>
      {received ? <Button variant="secondary" onClick={() => { void change({ type: 'respond_offer', expectedVersion: version, offerId: received.id, response: 'decline' }); }}>{copy.decline}</Button> :
        <Button variant="secondary" onClick={() => setOpen('cancel')}>{copy.closeRequest}</Button>}</>;
  } else if (received && pickup.status === 'assigned') {
    buttons = <><Button onClick={() => setOpen('car')}>{copy.acceptOffer}</Button><Button variant="secondary" onClick={() => { void change({ type: 'respond_offer', expectedVersion: version, offerId: received.id, response: 'decline' }); }}>{copy.decline}</Button></>;
  } else if (sent) {
    buttons = <><Button variant={compact ? 'plain' : 'primary'} disabled={busy} onClick={depart}>{pickup.destination.confirmed ? copy.departure : copy.carCheckMap}</Button><Button variant={compact ? 'primary' : 'secondary'} disabled={busy} onClick={() => { void change({ type: 'cancel_offer', expectedVersion: version, offerId: sent.id }); }}>{copy.handoffCancel}</Button></>;
  } else if (assignee && pickup.status === 'assigned') {
    buttons = <><Button disabled={busy} onClick={depart}>{pickup.destination.confirmed ? copy.departure : copy.carCheckMap}</Button>{handoff}</>;
  } else if (assignee && pickup.status === 'en_route') {
    buttons = <><Button disabled={busy} onClick={() => { void change({ type: 'arrive', source: 'manual', expectedVersion: version }); }}>{copy.arrival}</Button>
      {pickup.enRouteAt != null && now - pickup.enRouteAt <= 5 * minute && !compact && <Button variant="plain" onClick={() => setOpen('undo')}>{copy.undoDeparture}</Button>}
      {!compact && <Button variant="plain" onClick={() => setOpen('cancel')}>{copy.cancelPickup}</Button>}</>;
  } else if (assignee && pickup.status === 'arrived') {
    const phone = requesterPhone(state, pickup);
    buttons = <>{pickup.notMetAt != null && compact && <CallRequester state={state} pickup={pickup} />}
      {(!compact || pickup.notMetAt == null || state.live && !phone) && <Button disabled={busy} onClick={() => { void change({ type: 'board', expectedVersion: version }); }}>{copy.boarded}</Button>}
      <Button variant={compact ? 'secondary' : 'plain'} onClick={() => setOpen('cancel')}>{copy.notMet}</Button></>;
  } else if (fromSelf && isActivePickup(pickup)) {
    buttons = <Link className="button button--primary" to="/p/request">{copy.detailView}</Link>;
  } else if (!assignee && eligible && pickup.status === 'assigned') {
    buttons = <><Button disabled={busy} onClick={() => setOpen('takeover')}>{copy.takeOver}</Button><Button variant="secondary" onClick={() => setOpen('cancel')}>{copy.cancelPickup}</Button></>;
  }
  const close = () => setOpen(null);
  const footHolds = assignee && pickup.status === 'assigned';
  return <>
    {buttons && <div className={`guardian-actions ${compact && pickup.status !== 'arrived' ? 'guardian-actions--inline' : ''}`}>{buttons}</div>}
    {offerResult && canDeclare && <div className="guardian-actions guardian-actions--text">{declare('plain')}</div>}
    {!compact && (footHolds || canDeclare) && <div className="guardian-actions guardian-actions--foot">
      {footHolds && <Button variant="plain" onClick={() => setOpen('cancel')}>{copy.cancelPickup}</Button>}
      {footHolds && pickup.source === 'routine' && <Button variant="plain" onClick={() => setOpen('skip')}>{copy.skipRoutine}</Button>}
      {canDeclare && declare('plain')}
    </div>}
    {open === 'no_driver' && <NoDriverSheet state={state} pickup={pickup} close={close} confirm={async (note) => {
      const result = await act(pickup, actor, { type: 'no_driver', expectedVersion: version, note }, copy.noDriverSent(nameOf(state, pickup.requester.id)));
      if (result.ok) close();
    }} />}
    {(open === 'car' || open === 'takeover') && <AcceptSheet state={state} member={member} close={close} takeover={open === 'takeover' ? nameOf(state, pickup.assigneeId) : undefined} accept={async (vehicleId) => {
      const result = await change(open === 'takeover' ? { type: 'take_over', expectedVersion: version, vehicleId } : received ? { type: 'respond_offer', expectedVersion: version, offerId: received.id, response: 'accept', vehicleId } : { type: 'accept', vehicleId });
      if (result.ok) close();
    }} />}
    {open === 'cancel' && <CancelSheet close={close} arrived={pickup.status === 'arrived'} label={pickup.status === 'open' ? copy.closeRequest : pickup.status === 'arrived' ? copy.notMet : copy.cancelPickup} confirm={async (reasonIndex) => {
      const reasons = ['resolved_by_phone', 'mistake', 'other_way_home', 'other'] as const;
      const reason = pickup.status === 'arrived' ? 'not_met' : reasons[reasonIndex];
      const result = await act(pickup, actor, { type: 'cancel', expectedVersion: version, reason }, undefined, { detail: pickup.status === 'arrived' ? copy.notMet : copy.cancelReasons[reasonIndex] });
      if (result.ok) close();
    }} />}
    {open === 'skip' && <Sheet title={copy.skipRoutineQuestion} close={close}><div className="stack"><Button disabled={busy} onClick={async () => {
      const result = await change({ type: 'cancel', expectedVersion: version, reason: 'skipped' }); if (result.ok) close();
    }}>{copy.skipRoutine}</Button><Button variant="secondary" onClick={close}>{copy.back}</Button></div></Sheet>}
    {open === 'undo' && <Sheet title={copy.undoQuestion} close={close}><div className="stack"><Button disabled={busy} onClick={async () => {
      const result = await change({ type: 'undo_en_route', expectedVersion: version }); if (result.ok) close();
    }}>{copy.undoDeparture}</Button><Button variant="secondary" onClick={close}>{copy.back}</Button></div></Sheet>}
  </>;
}

function AcceptSheet({ state, member, close, accept, takeover }: { state: DemoState; member: Person; close: () => void; accept: (vehicleId?: string) => Promise<void>; takeover?: string }) {
  const vehicles = (state.vehicles ?? [state.vehicle]).filter((vehicle) => vehicle.currentDriverId === member.id);
  const [car, setCar] = useState(vehicles[0]?.id ?? '');
  const pending = usePickupOperations()?.pending;
  return <Sheet title={takeover ? copy.takeOverQuestion(takeover) : copy.chooseCar} close={close}><div className="guardian-sheet-flow">
    {takeover && <span className="guardian-takeover-icon"><CarFront size={30} /></span>}
    {vehicles.map((vehicle) => <RadioLine key={vehicle.id} name="car" value={vehicle.id} selected={car} change={setCar} label={vehicle.name} hint={`${copy.driver} ${member.name}, ${vehicle.rangeStale ? copy.staleValue : copy.range(vehicle.range)}`} />)}
    <RadioLine name="car" value="" selected={car} change={setCar} label={copy.otherCar} />
    <div className="stack sheet-actions"><Button disabled={pending} onClick={() => { void accept(car || undefined); }}>{copy.accept}</Button><Button variant={takeover ? 'secondary' : 'plain'} onClick={close}>{takeover ? copy.back : copy.close}</Button></div>
  </div></Sheet>;
}

function CancelSheet({ close, confirm, arrived, label }: { close: () => void; confirm: (reasonIndex: number) => Promise<void>; arrived: boolean; label: string }) {
  const [reason, setReason] = useState<string>(copy.cancelReasons[0]);
  const pending = usePickupOperations()?.pending;
  return <Sheet title={arrived ? copy.notMet : copy.cancelReason} close={close}>
    {!arrived && copy.cancelReasons.map((item) => <RadioLine key={item} name="reason" value={item} selected={reason} change={setReason} label={item} />)}
    <div className="stack sheet-actions"><Button disabled={pending} onClick={() => { void confirm(copy.cancelReasons.findIndex((item) => item === reason)); }}>{label}</Button><Button variant="plain" onClick={close}>{copy.back}</Button></div>
  </Sheet>;
}

function HandoffPage({ state, member, pickup, close, back }: CardProps & { close: () => void; back: string }) {
  const candidates = state.members.filter((person) => person.canDrive && person.leftAt == null && person.id !== member.id && person.id !== pickup.requester.id);
  const [to, setTo] = useState(candidates[0]?.id ?? '');
  const [note, setNote] = useState('');
  const act = usePickupAction();
  const busy = usePickupOperations()?.pending;
  const car = (state.vehicles ?? [state.vehicle]).find((vehicle) => vehicle.id === pickup.vehicleId);
  const required = car ? rangeEstimate(state, [pickup], car).requiredKm : null;
  // 24.5 P-06: a guardian whose day off is the pickup's date stays selectable, with "못 가는 날" under the name.
  const off = unavailableFor(state, pickup);
  return <><MobileHeader back={back} className="guardian-back-header" /><div className="mobile-content guardian-flow">
    <h1>{copy.handoffQuestion}</h1>
    <div className="guardian-handoff-summary"><p className="handoff-place"><strong>{clock(pickup.wantedAt)}</strong> {nameOf(state, pickup.requester.id)}, {destinationLabel(state, pickup.destination)}</p>
      {required != null && <div className="guardian-handoff-distance"><span>{copy.rangeNeed(required)}</span><span>{copy.homeOrigin}</span></div>}</div>
    {candidates.map((person) => {
      const vehicle = (state.vehicles ?? [state.vehicle]).find((item) => item.currentDriverId === person.id);
      const estimate = vehicle ? rangeEstimate(state, [pickup], vehicle) : undefined;
      const hint = vehicle ? [vehicle.name, vehicle.rangeStale ? copy.staleValue : copy.range(vehicle.range),
        estimate?.requiredKm == null ? null : `${copy.rangeNeed(estimate.requiredKm)} (${copy.homeOrigin})`,
        estimate?.verdict === 'low' ? copy.rangeInsufficient : estimate?.verdict === 'check' ? copy.rangeCheck : null].filter(Boolean).join(', ') : copy.noCar;
      return <RadioLine name="handoff" value={person.id} key={person.id} selected={to} change={setTo} label={person.name}
        hint={off.includes(person.id) ? <><span className="guardian-off-day">{copy.unavailableTitle}</span>{hint}</> : hint} />;
    })}
    {candidates.length > 0 && <RadioLine name="handoff" value="" selected={to} change={setTo} label={copy.handoffAllLabel} hint={copy.firstAccepts} />}
    <div className="stack guardian-flow-gap"><fieldset><legend>{copy.handoffNote}</legend><div className="chips">{copy.handoffNotes.map((item) => <button key={item} type="button" className="chip chip--small" aria-pressed={note === item} onClick={() => setNote(item)}>{item}</button>)}</div></fieldset>
      <label className="field guardian-note"><input aria-label={copy.handoffNote} value={note} maxLength={40} placeholder={copy.handoffPlaceholder} onChange={(event) => setNote(event.target.value)} /><span aria-hidden="true">{note.length}/40</span></label>
    </div>
    <div className="guardian-flow-actions stack">
      <p className="small muted place-meta"><Info size={17} />{copy.handoffResponsibility}</p>
      <Button disabled={!candidates.length || busy} onClick={async () => {
        const result = await act(pickup, { kind: 'member', id: member.id }, { type: 'offer', expectedVersion: pickup.version, offerId: uid(), toMemberId: to || undefined, note: note.trim() || undefined });
        if (result.ok) close();
      }}>{copy.handoffAccept(to ? nameOf(state, to) : copy.handoffAll)}</Button>
    </div>
  </div></>;
}

export function LocationSheet({ state, pickup, actor, close, fullPage = false, back = pickupPath(pickup) }: { state: DemoState; pickup: Pickup; actor: Actor; close: () => void; fullPage?: boolean; back?: string }) {
  const act = usePickupAction();
  const busy = usePickupOperations()?.pending;
  const navigate = useNavigate();
  const [destination, setDestination] = useState<Destination>(pickup.destination);
  function selectPlace(placeId: string) {
    const resolved = resolveDestination(pickup.familyId || familyId, { source: 'saved_place', placeId }, state.places);
    if (!resolved) return;
    if (fullPage) setDestination(resolved);
    else void confirm(resolved);
  }
  function move(coords: Coordinates) {
    setDestination((previous) => Math.abs(previous.lat - coords.lat) + Math.abs(previous.lng - coords.lng) <= 0.00001 ? previous : {
      ...coords, confirmed: true, source: 'map_pin', label: copy.placeGeneric, note: pickup.destination.note,
    });
  }
  async function confirm(point = destination) {
    const result = await act(pickup, actor, { type: 'confirm_location', expectedVersion: pickup.version, destination: { ...point, confirmed: true } });
    if (result.ok) close();
  }
  const content = <>
    <MapPreview coords={destination} onMove={fullPage ? move : undefined} uncertain={!destination.confirmed} />
    <p className="place-meta guardian-location-meta"><MapPin size={17} />{destination.label}{!state.live && !destination.confirmed ? `, ${copy.mapAcc}` : ''}</p>
    <h3>{copy.nearbyPlaces}</h3>
    {nearbyPlaces(state, pickup.destination).map(({ place, distance }) => <Row key={place.id} icon={['academy', '학원', 'school', '학교'].includes(place.kind) ? <GraduationCap size={17} /> : <MapPin size={17} />} title={place.label} trailing={copy.distance(distance)} onClick={() => selectPlace(place.id)} />)}
    <div className={`stack ${fullPage ? 'guardian-flow-actions' : 'sheet-actions'}`}><Button disabled={busy} onClick={() => { void confirm(); }}>{copy.confirmHere}</Button>
      {actor.kind === 'member' && <Button variant="plain" onClick={() => navigate('/p/places/new', { state: { fromPickup: pickup.id, coords: { lat: destination.lat, lng: destination.lng } } })}>{copy.saveThisPlace}</Button>}
      {!fullPage && <Button variant="plain" onClick={close}>{copy.back}</Button>}</div>
  </>;
  return fullPage ? <><MobileHeader className="guardian-back-header" back={back} /><div className="mobile-content guardian-flow guardian-location"><h1>{copy.confirmLocation}</h1>{content}</div></> : <Sheet title={copy.confirmLocation} close={close}>{content}</Sheet>;
}

function PickupCard({ state, member, pickup, now, dismissed, acknowledge }: CardProps & { now: number; dismissed: boolean; acknowledge: (id: string) => void }) {
  const name = nameOf(state, pickup.requester.id);
  const assignee = nameOf(state, pickup.assigneeId);
  const place = destinationLabel(state, pickup.destination);
  const offer = pickup.offer;
  const sent = offer?.status === 'pending' && offer.fromMemberId === member.id;
  const received = offer?.status === 'pending' && offer.fromMemberId && offer.fromMemberId !== member.id && (!offer.toMemberId || offer.toMemberId === member.id) && !offer.declinedBy.includes(member.id) && requestRecipients(pickup, state.members).memberIds.includes(member.id);
  const offerResult = !dismissed && offer?.fromMemberId === member.id && (offer.status === 'declined' || offer.status === 'expired');
  const request = pickup.status === 'open' && pickup.source === 'request' && !received;
  const boardingLate = pickup.status === 'arrived' && pickup.arrivedAt != null && now >= pickup.arrivedAt + 30 * minute;
  const early = pickup.readyAt != null && pickup.status === 'assigned';
  const notMet = pickup.status === 'arrived' && pickup.notMetAt != null;
  const elapsed = state.history.find((event) => event.pickupId === pickup.id && event.event === 'requested')?.at;
  const vehicle = (state.vehicles ?? [state.vehicle]).find((car) => car.id === pickup.vehicleId);
  const estimate = vehicle ? rangeEstimate(state, [pickup], vehicle) : undefined;
  let title = copy.requestHeadline(name);
  if (notMet) title = copy.notMetHeadline(name);
  else if (boardingLate) title = copy.boardingFollowup(name);
  else if (sent) title = copy.handoffWaiting(nameOf(state, offer.toMemberId) || copy.handoffAll);
  else if (received) title = copy.handoffReceived(nameOf(state, offer.fromMemberId));
  else if (offerResult) title = (offer.status === 'declined' ? copy.handoffDeclined : copy.handoffExpired)(nameOf(state, offer.toMemberId) || copy.handoffAll);
  else if (early) title = copy.earlyHeadline(name);
  else if (pickup.source === 'routine' && pickup.status === 'assigned') title = `${clock(pickup.wantedAt)} ${name}, ${copy.awaitingDeparture}`;
  else if (pickup.status !== 'open') title = `${name}, ${copy.statuses[pickup.status]}`;
  return <article className={`pickup-card guardian-card ${sent || received || offerResult ? 'guardian-card--offer' : ''}`}>
    {request && <div className="pickup-card-top"><span className="avatar" aria-hidden="true">{name[0]}</span><span>{elapsed == null || now - elapsed < minute ? copy.dateNow : copy.pickupAge(Math.floor((now - elapsed) / minute))}</span></div>}
    {early && !sent && !received && !offerResult && <div><Badge>{copy.readyBadge(name)}</Badge></div>}
    <h3><Link to={pickupPath(pickup)} className="guardian-card-title">
      {sent || received ? <UserRound aria-hidden="true" size={21} /> : offerResult || boardingLate || notMet ? <CircleAlert aria-hidden="true" className="danger-text" size={21} /> : null}
      <span>{title}</span><ChevronRight aria-hidden="true" size={17} />
    </Link></h3>
    {boardingLate && !notMet && <p className="muted">{copy.boardingLate}</p>}
    {offerResult && <p className="muted">{pickup.assigneeId === member.id ? copy.handoffStillMine : copy.handoffStill(assignee)}</p>}
    {sent || received || offerResult ? <p className="guardian-card-schedule"><strong>{clock(pickup.wantedAt)}</strong>{name}, {place}</p> :
      <div className="guardian-card-location"><p className="place-meta"><MapPin size={17} /><span><span>{place}</span>{request ? `, ${elapsed != null && pickup.wantedAt <= elapsed + minute ? copy.dateNow : clock(pickup.wantedAt)}` : ''}</span></p>{pickup.status === 'arrived' && <Status pickup={pickup} />}</div>}
    {!pickup.destination.confirmed && <Badge>{copy.locationNotConfirmed}</Badge>}
    {received && offer.note && <blockquote>“{offer.note}”</blockquote>}
    {received && vehicle && <p className="place-meta"><CarFront size={17} />{vehicle.rangeStale ? copy.staleValue : copy.range(vehicle.range)}{estimate?.requiredKm != null ? `, ${copy.rangeNeed(estimate.requiredKm)}` : ''}</p>}
    {assignee ? <p className="place-meta assignee">{sent || received ? <span className="guardian-amber-dot" /> : <UserRound size={17} />}{copy.assignee} {assignee}{(sent || received) && offer.toMemberId ? ` (${copy.handoffWaiting(nameOf(state, offer.toMemberId))})` : ''}</p> : request && <p className="small muted guardian-awaiting">{copy.awaitingAssignee}</p>}
    {sent && <><p className="small">{copy.handoffResponsibility}</p><p className="small muted place-meta"><Clock3 size={16} />{copy.codeRemaining(Math.max(0, Math.ceil((offer.expiresAt - now) / minute)))}</p></>}
    <PickupActions state={state} member={member} pickup={pickup} compact showOfferResult={offerResult} acknowledge={offer ? () => acknowledge(offer.id) : undefined} />
  </article>;
}

/** "지금" time of a request asked for right away, otherwise its wanted time. */
function wantedLabel(state: DemoState, pickup: Pickup) {
  const requested = state.history.find((event) => event.pickupId === pickup.id && event.event === 'requested')?.at;
  return pickup.source === 'request' && requested != null && pickup.wantedAt <= requested + minute ? copy.dateNow : clock(pickup.wantedAt);
}

/** P-04 "갈 사람 없음" (24.5): an open pickup nobody can drive, first in "지금", shaped like the declined-handoff card. */
function NobodyCard({ state, member, pickup }: CardProps) {
  const name = nameOf(state, pickup.requester.id);
  return <article className="pickup-card guardian-card guardian-card--offer" aria-live="polite">
    <h3><Link to={pickupPath(pickup)} className="guardian-card-title"><CircleAlert aria-hidden="true" className="danger-text" size={21} /><span>{copy.nobodyCardTitle(name)}</span><ChevronRight aria-hidden="true" size={17} /></Link></h3>
    <p className="guardian-card-schedule"><strong>{wantedLabel(state, pickup)}</strong>{name}, {destinationLabel(state, pickup.destination)}</p>
    <p className="small muted">{copy.nobodyCardHint}</p>
    <PickupActions state={state} member={member} pickup={pickup} compact pair />
  </article>;
}

/**
 * P-04 after "못 간다고 알리기" (24.5): 확인 전 (5 minutes), 미확인 5분, 확인됨 (10 minutes). "확인" closes the card on
 * this screen only; an unacknowledged card closed early comes back as the 5-minute card.
 */
function FallbackCard({ state, member, pickup, stage, dismiss }: CardProps & { stage: FallbackStage; dismiss: () => void }) {
  const name = nameOf(state, pickup.requester.id);
  const note = pickup.fallbackNote ?? '';
  const by = fallbackByName(state, pickup);
  const title = stage === 'acked' ? copy.fallbackAcked(name) : stage === 'unacked' ? copy.fallbackUnacked(name) :
    pickup.fallbackBy === member.id || !by ? copy.fallbackSent(name) : copy.fallbackSentBy(by, name);
  const Icon = stage === 'acked' ? CircleCheck : stage === 'unacked' ? CircleAlert : Clock3;
  return <article className="pickup-card guardian-card guardian-card--offer" aria-live="polite">
    <h3><Link to={pickupPath(pickup)} className="guardian-card-title"><Icon aria-hidden="true" className={stage === 'acked' ? 'success-text' : stage === 'unacked' ? 'danger-text' : undefined} size={21} /><span>{title}</span><ChevronRight aria-hidden="true" size={17} /></Link></h3>
    <p className="guardian-card-note">{stage === 'acked' && pickup.fallbackAckAt != null ? copy.fallbackNoteWithTime(note, clock(pickup.fallbackAckAt)) : note}</p>
    {stage === 'sent' && <p className="place-meta"><span className="guardian-amber-dot" aria-hidden="true" />{copy.fallbackPending(name)}</p>}
    <div className="guardian-actions guardian-actions--inline">
      {stage !== 'acked' && <CallRequester state={state} pickup={pickup} />}
      <Button variant="secondary" onClick={dismiss}>{copy.confirm}</Button>
    </div>
  </article>;
}

/** P-04 "내일" (24.5): tomorrow's routine occurrence nobody holds yet. */
function TomorrowCard({ state, member, pickup }: CardProps) {
  const nobody = isNobodyAvailable(state, pickup);
  return <article className="pickup-card guardian-card guardian-card--later">
    <h3><Link to={pickupPath(pickup)} className="guardian-card-title guardian-card-schedule"><strong>{clock(pickup.wantedAt)}</strong><span>{nameOf(state, pickup.requester.id)}, {destinationLabel(state, pickup.destination)}</span><ChevronRight aria-hidden="true" size={17} /></Link></h3>
    <p className={`small ${nobody ? 'danger-text' : 'muted'}`}>{nobody ? copy.tomorrowNobody : copy.tomorrowNoAssignee}</p>
    <PickupActions state={state} member={member} pickup={pickup} compact pair />
    <UnavailableLink from="/p/" />
  </article>;
}

function TimelineRow({ to, time, name, place, meta }: { to: string; time: string; name: string; place: string; meta?: string }) {
  return <Link className="guardian-timeline-row" to={to}><time>{time}</time><span className="avatar" aria-hidden="true">{name[0]}</span><strong>{name}, {place}</strong>{meta && <small>{meta}</small>}</Link>;
}

export function GuardianHome({ state, member }: { state: DemoState; member: Person }) {
  const now = useClock(state);
  const [dismissedOffers, setDismissedOffers] = useState<string[]>([]);
  const [dismissedFallbacks, setDismissedFallbacks] = useState<string[]>([]);
  const visible = state.pickups.filter((pickup) => pickup.status !== 'open' || requestRecipients(pickup, state.members).memberIds.includes(member.id) || pickup.requester.id === member.id);
  // 24장: "갈 사람 없음" first in "지금", declarations until the requester's "알겠어", tomorrow's open occurrences in "내일".
  const sections = noDriverSections(state, member.id, visible, now, dismissedFallbacks);
  const special = new Set([...sections.nobody, ...sections.fallback.map(({ pickup }) => pickup), ...sections.tomorrow]);
  // A family-wide offer counts only while pending; once taken or lapsed it is no news, as in the live feed (visible_offer).
  const offerCard = (pickup: Pickup) => pickup.offer != null && (pickup.offer.status === 'pending' || pickup.offer.fromMemberId != null) && !dismissedOffers.includes(pickup.offer.id);
  const cards = visible.filter((pickup) => !special.has(pickup) && isActivePickup(pickup) && (pickup.source === 'request' || pickup.readyAt != null || offerCard(pickup) || pickup.status === 'en_route' || pickup.status === 'arrived' || pickup.status === 'assigned' && pickup.assigneeId === member.id && now >= pickup.wantedAt - 5 * minute));
  const displayed = visible.filter((pickup) => !cards.includes(pickup) && !special.has(pickup));
  const routines = state.live ? [] : demoRoutinesToday(state, now);
  const today = displayed.filter((pickup) => dateLabel(pickup.wantedAt) === dateLabel(now)).sort((a, b) => a.wantedAt - b.wantedAt);
  const tomorrowAt = now + 1440 * minute;
  const tomorrow = displayed.filter((pickup) => dateLabel(pickup.wantedAt) === dateLabel(tomorrowAt)).sort((a, b) => a.wantedAt - b.wantedAt);
  const tomorrowRoutines = state.live ? [] : demoRoutinesToday(state, tomorrowAt);
  function timeline(pickup: Pickup) {
    return <TimelineRow key={pickup.id} to={pickupPath(pickup)} time={clock(pickup.wantedAt)} name={nameOf(state, pickup.requester.id)} place={destinationLabel(state, pickup.destination)} meta={pickup.status === 'assigned' ? `${copy.assignee} ${nameOf(state, pickup.assigneeId)}` : statusLabel(pickup)} />;
  }
  function routineRows(items: typeof routines) { return [...items].sort((a, b) => a.time.localeCompare(b.time)).map((routine) => <TimelineRow key={routine.id} to={`/p/routines/${routine.id}`} time={routine.time} name={nameOf(state, routine.requester.id)} place={state.places.find((p) => p.id === routine.placeId)?.label ?? copy.location} meta={routine.assigneeId ? `${copy.assignee} ${nameOf(state, routine.assigneeId)}` : copy.noAssignee} />); }
  const own = cards.find((pickup) => pickup.requester.kind === 'member' && pickup.requester.id === member.id);
  return <>
    <MobileHeader title={copy.app}><HeaderBell /></MobileHeader>
    <div className="mobile-content guardian-home">
      <div className="today-line"><p>{dateLabel(now)}</p>{member.canRequest && <Link className="button button--outline button--compact" to="/p/request"><MapPin size={16} />{copy.requestSelf}</Link>}</div>
      {!state.live && !state.notifications && <div className="guardian-notify-banner"><Bell size={17} /><span>{copy.notificationOffBanner}</span><Link to="/p/notifications">{copy.enableNotification}</Link></div>}
      {state.smsFailures != null && state.smsFailures > 0 && <p className="network-banner" role="status">{copy.smsFailureBanner}</p>}
      <section className="guardian-now" aria-labelledby="guardian-now-title"><h2 id="guardian-now-title">{copy.now}</h2>
        {sections.nobody.map((pickup) => <NobodyCard key={`${member.id}-${pickup.id}`} state={state} member={member} pickup={pickup} />)}
        {sections.fallback.map(({ pickup, stage }) => <FallbackCard key={`${member.id}-${pickup.id}`} state={state} member={member} pickup={pickup} stage={stage}
          dismiss={() => setDismissedFallbacks((previous) => [...previous, fallbackKey(pickup, stage)])} />)}
        {own && <Link to="/p/request" className="pickup-card own-pickup"><Status pickup={own} /><h3>{copy.requestSent}</h3><p className="place-meta"><MapPin size={17} />{destinationLabel(state, own.destination)}</p><span>{copy.detailView} <ChevronRight size={16} /></span></Link>}
        {!own && sections.ownFallback && <Link to="/p/request" className="pickup-card own-pickup"><Status pickup={sections.ownFallback} /><h3>{declarationTitle(sections.ownFallback, now)}</h3>{sections.ownFallback.fallbackNote && <p className="place-meta">{sections.ownFallback.fallbackNote}</p>}<span>{copy.detailView} <ChevronRight size={16} /></span></Link>}
        {cards.filter((pickup) => pickup !== own).map((pickup) => <PickupCard key={`${member.id}-${pickup.id}`} state={state} member={member} pickup={pickup} now={now} dismissed={Boolean(pickup.offer && dismissedOffers.includes(pickup.offer.id))} acknowledge={(id) => setDismissedOffers((previous) => [...previous, id])} />)}
        {!cards.length && !sections.nobody.length && !sections.fallback.length && !sections.ownFallback && <div className="quiet-card"><span className="quiet-icon"><CalendarDays size={23} /></span><div><strong>{copy.noneNow}</strong><p>{copy.nextRoutine}</p></div></div>}
      </section>
      {sections.tomorrow.length > 0 && <section className="guardian-now guardian-next-day" aria-labelledby="guardian-tomorrow-title"><h2 id="guardian-tomorrow-title">{copy.tomorrow}</h2>
        {sections.tomorrow.map((pickup) => <TomorrowCard key={`${member.id}-${pickup.id}`} state={state} member={member} pickup={pickup} />)}
      </section>}
      <section className="schedule"><h2>{copy.todaySchedule}</h2>
        {today.map(timeline)}
        {routineRows(routines)}
        {!routines.length && !today.length && <Placeholder text={copy.noneToday} />}
      </section>
      {tomorrow.length + tomorrowRoutines.length > 0 && <details className="schedule guardian-tomorrow"><summary><strong>{copy.tomorrowSchedule}</strong><span>{tomorrow.length + tomorrowRoutines.length}</span><ChevronDown aria-hidden="true" size={17} /></summary>{tomorrow.map(timeline)}{routineRows(tomorrowRoutines)}</details>}
      {state.live && (!state.riders.length || !state.places.length || !state.vehicles?.length) && <section className="schedule"><h2>{copy.setupChecklist}</h2>
        {!state.riders.length && <Row icon={<UserRound size={18} />} title={copy.addRider} to="/p/riders/new" />}
        {!state.places.length && <Row icon={<MapPin size={18} />} title={copy.placeAdd} to="/p/places/new" />}
        {!state.vehicles?.length && <Row icon={<CarFront size={18} />} title={copy.carConnect} to="/p/vehicles/pair" />}
      </section>}
    </div>
  </>;
}

/** P-05 history line: "엄마가 못 간다고 알림" and "민준이 확인" (24.5); other events keep "아빠 담당 정해짐". */
function recordLine(state: DemoState, event: History) {
  const actor = nameOf(state, event.actor);
  if (actor && event.event === 'no_driver') return copy.noDriverRecord(actor);
  if (actor && event.event === 'fallback_acknowledged') return copy.fallbackAckRecord(actor);
  return [actor, eventText[event.event]].filter(Boolean).join(' ');
}

export function PickupDetail({ state, member, mode, pickupId }: { state: DemoState; member: Person; mode?: 'handoff' | 'location'; pickupId?: string }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const route = useLocation();
  const pickup = state.pickups.find((item) => item.id === (pickupId ?? id));
  if (!pickup) return <><MobileHeader title={copy.details} back="/p/" /><Placeholder text={copy.missing} /></>;
  const place = destinationLabel(state, pickup.destination);
  const name = nameOf(state, pickup.requester.id);
  const assignee = nameOf(state, pickup.assigneeId);
  const events = state.history.filter((event) => event.pickupId === pickup.id).sort((a, b) => b.at - a.at);
  const vehicle = (state.vehicles ?? [state.vehicle]).find((car) => car.id === pickup.vehicleId);
  const estimate = vehicle ? rangeEstimate(state, [pickup], vehicle) : undefined;
  const progress = ['requested', 'accepted', 'en_route', 'arrived', 'completed'] as const;
  const currentStep = ['assigned', 'en_route', 'arrived', 'completed'].indexOf(pickup.status) + 1;
  const coordinatesAvailable = state.pickupCapabilities?.[pickup.id]?.coordinates !== false;
  const actor: Actor = { kind: 'member', id: member.id };
  const back = route.state?.returnToPickupHome === true ? '/p/' : pickupPath(pickup);
  const closeFlow = () => navigate(back);
  if (mode === 'handoff' && pickup.status === 'assigned' && pickup.assigneeId === member.id) return <HandoffPage state={state} member={member} pickup={pickup} close={closeFlow} back={back} />;
  if (mode === 'location' && coordinatesAvailable && pickup.assigneeId === member.id) return <LocationSheet fullPage state={state} pickup={pickup} actor={actor} close={closeFlow} back={back} />;
  return <>
    <MobileHeader title={`${name}, ${pickup.source === 'request' && events.some((event) => event.event === 'requested' && pickup.wantedAt <= event.at + minute) ? copy.dateNow : clock(pickup.wantedAt)}`} back="/p/" className="guardian-detail-header" />
    <div className="mobile-content pickup-detail guardian-detail">
      <p className="guardian-detail-origin muted">{pickup.source === 'request' ? copy.requestOrigin(name) : copy.routine}</p>
      {pickup.status === 'closed_unconfirmed' && <div className="guardian-terminal"><Status pickup={pickup} /><h2>{copy.closedUnconfirmed}</h2></div>}
      {coordinatesAvailable && pickup.status !== 'closed_unconfirmed' && <MapPreview coords={pickup.destination} marker={place} uncertain={!pickup.destination.confirmed} />}
      {!pickup.destination.confirmed && pickup.assigneeId === member.id && coordinatesAvailable && <Link className="button button--outline" to={`${pickupPath(pickup)}/location`}><MapPin size={17} />{copy.carCheckMap}</Link>}
      {pickup.status !== 'closed_unconfirmed' && <h2 className={`guardian-detail-state guardian-detail-state--${pickup.status}`}>{pickup.status === 'completed' ? <span><Check size={13} strokeWidth={3} /></span> : <span />}{statusLabel(pickup)}</h2>}
      <ol className="detail-steps guardian-detail-steps">{progress.map((kind, index) => {
        const row = events.find((event) => event.event === kind || kind === 'accepted' && (event.event === 'offer_accepted' || event.event === 'took_over'));
        const stamp = row?.at ?? (kind === 'accepted' ? pickup.acceptedAt : kind === 'en_route' ? pickup.enRouteAt : kind === 'arrived' ? pickup.arrivedAt : null);
        const done = kind === 'en_route' && pickup.status === 'assigned' ? false : stamp != null || index <= currentStep;
        const label = kind === 'requested' ? pickup.source === 'routine' ? copy.plannedStep : copy.requestStep : kind === 'accepted' && assignee ? `${assignee} ${copy.assignee}` : eventText[kind];
        return <li key={kind} className={kind === 'completed' && done ? 'is-complete' : ''}><StepCheck done={done} /><strong>{label}</strong>{stamp != null && done && <time>{clock(stamp)}</time>}</li>;
      })}</ol>
      <dl className="guardian-facts">
        <div><dt>{copy.assignee}</dt><dd>{assignee || copy.noAssignee}</dd></div>
        {assignee && <div><dt>{copy.cars}</dt><dd>{vehicle?.name ?? copy.noVehicle}</dd></div>}
        {vehicle && <div><dt>{copy.rangeTitle}</dt><dd>{vehicle.rangeStale ? copy.staleValue : vehicle.range == null ? copy.rangeCheck : `${vehicle.range}km`}{estimate?.requiredKm != null ? `, ${copy.rangeNeed(estimate.requiredKm)}` : ''}{vehicle.rangeCollectedAt && <small>{copy.collectionTime} {clock(vehicle.rangeCollectedAt)}</small>}</dd></div>}
        {pickup.cancelReason === 'no_driver' && <>
          <div><dt>{copy.insteadTitle}</dt><dd>{pickup.fallbackNote}</dd></div>
          <div><dt>{name}</dt><dd>{pickup.fallbackAckAt != null ? copy.ackAt(clock(pickup.fallbackAckAt)) : copy.ackPending}</dd></div>
        </>}
      </dl>
      <PickupActions key={`${member.id}-${pickup.id}`} pickup={pickup} member={member} state={state} />
      {events.length > 0 && <section className="schedule guardian-record"><h2>{copy.record}</h2>{events.map((event, index) => <Row key={`${event.at}-${index}`} icon={<time>{clock(event.at)}</time>} title={recordLine(state, event)} caption={event.detail} />)}</section>}
    </div>
  </>;
}

export function NotificationLayout({ enabled, description, installHint, children }: { enabled: boolean; description?: string; installHint?: string; children: React.ReactNode }) {
  return <div className="mobile-content guardian-notification"><div className="guardian-notification-intro">
    {enabled ? <span className="success-circle"><Check size={30} strokeWidth={3} /></span> : <span className="guardian-notification-bell"><Bell size={55} strokeWidth={1.65} /></span>}
    <h2>{enabled ? copy.notificationEnabled : copy.notificationTitle}</h2>
    {description && <p className="muted">{description}</p>}
  </div>
    {installHint && <p className="guardian-install-tip"><Smartphone size={25} /><span>{installHint}</span></p>}
    <div className="stack guardian-notification-actions">{children}</div>
  </div>;
}

export function GuardianNotifications({ state }: { state: DemoState }) {
  const commit = useCommit();
  const toast = useToast();
  return <><MobileHeader title={copy.app} back="/p/" className="guardian-brand-header" />
    <NotificationLayout enabled={state.notifications} description={!state.notifications ? copy.notificationDescription : undefined} installHint={!state.notifications ? copy.pushInstall : undefined}>
      <p className="small muted guardian-demo-note">{copy.demoNotificationHint}</p>
      {state.notifications ? <Button onClick={() => toast(copy.testSent)}>{copy.notifyTestAction}</Button> : <Button onClick={() => { void commit((current) => ({ ok: true, state: { ...current, notifications: true } })); }}>{copy.enableNotification}</Button>}
      <Link className="button button--secondary" to="/p/">{state.notifications ? copy.todayGo : copy.later}</Link>
      {state.history.length > 0 && <details className="guardian-tomorrow guardian-notification-record"><summary><strong>{copy.record}</strong><ChevronDown size={17} /></summary>{state.history.map((event, index) => <Row key={`${event.at}-${index}`} to={`/p/pickups/${event.pickupId}`} icon={<Clock3 size={18} />} title={eventText[event.event]} trailing={clock(event.at)} />)}</details>}
    </NotificationLayout>
  </>;
}
