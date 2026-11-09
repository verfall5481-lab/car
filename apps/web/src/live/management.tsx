import { useState } from 'react';
import { Bell, CalendarDays, CarFront, CircleAlert, CircleHelp, MapPin, Plus, Search, Shield, Smartphone, UserRound, Users } from 'lucide-react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import type { Coordinates } from '@deriro/contracts';
import { isCoordinates } from '@deriro/contracts';
import { clock, copy, dateLabel } from '../copy.ts';
import type { DemoState } from '../demo-domain.ts';
import { nameOf } from '../demo-domain.ts';
import { Badge, Button, HeaderBell, MapPreview, MobileHeader, Placeholder, RadioLine, Row, Sheet, useClock, useToast } from '../ui.tsx';
import { RoutineListRow } from '../management.tsx';
import { e164, InvitePanel, privacyVersion, PushSettings } from './accounts.tsx';
import { describeError, useClient, useLiveMutation } from './context.tsx';
import { browserPosition, searchPlaces, useMapKey } from './maps.tsx';
import type { PlaceResult } from './maps.tsx';
import type { Overview, Today, VehicleRow } from './models.ts';
import { unsubscribePush } from './platform.ts';

type Props = { overview: Overview; today?: Today; state: DemoState; path: string };

function Family({ overview, state }: Props) {
  return <><MobileHeader title={copy.family}><Link className="button button--plain" to="/p/settings">{copy.settings}</Link></MobileHeader>
    <div className="mobile-content family-page guardian-family-list">
      <section><h2>{copy.familyMembers}</h2>{overview.members.filter((row) => !row.left_at).map((row) => <Row key={row.id} icon={<UserRound size={19} />} title={row.display_name + (row.id === overview.me.id ? ` (${copy.me})` : '')} trailing={row.role === 'owner' ? copy.owner : undefined} to={`/p/members/${row.id}`} />)}<Row icon={<Plus size={19} />} title={copy.guardianInvite} to="/p/family/invite" /></section>
      <section><h2>{copy.person}</h2>{state.riders.filter((row) => !row.archivedAt).map((row) => <Row key={row.id} icon={<UserRound size={19} />} title={row.name} trailing={row.connected ? copy.connectedPhone : copy.unconnectedPhone} to={`/p/riders/${row.id}`} />)}<Row icon={<Plus size={19} />} title={copy.addRider} to="/p/riders/new" /></section>
      <section><h2>{copy.cars}</h2>{state.vehicles?.map((row) => <Row key={row.id} icon={<CarFront size={19} />} title={row.name} caption={`${copy.range(row.range)}, ${nameOf(state, row.currentDriverId) || copy.noAssignee}`} to={`/p/vehicles/${row.id}`} />)}<Row icon={<Plus size={19} />} title={copy.carConnect} to="/p/vehicles/pair" /></section>
      <section><h2>{copy.places}</h2>{state.places.filter((row) => !row.archivedAt).map((row) => <Row key={row.id} icon={<MapPin size={19} />} title={row.label} to={`/p/places/${row.id}`} />)}<Row icon={<Plus size={19} />} title={copy.placeAdd} to="/p/places/new" /></section>
    </div></>;
}

function Confirm({ title, confirmLabel, close, action, danger = false }: { title: string; confirmLabel: string; close: () => void; action: () => Promise<unknown>; danger?: boolean }) {
  const [pending, setPending] = useState(false);
  return <Sheet title={title} close={close}><div className="stack"><Button variant={danger ? 'danger' : 'primary'} disabled={pending} onClick={async () => { setPending(true); try { if (await action()) close(); } finally { setPending(false); } }}>{pending ? copy.loading : confirmLabel}</Button><Button variant="secondary" onClick={close}>{copy.back}</Button></div></Sheet>;
}

function MemberEdit({ overview, id }: { overview: Overview; id: string }) {
  const person = overview.members.find((row) => row.id === id && !row.left_at);
  const [drive, setDrive] = useState(person?.can_drive ?? false);
  const [request, setRequest] = useState(person?.can_request ?? false);
  const [confirm, setConfirm] = useState<'transfer' | 'remove' | null>(null);
  const { run, pending } = useLiveMutation();
  const navigate = useNavigate();
  if (!person) return <Navigate to="/p/family" replace />;
  const self = id === overview.me.id;
  const owner = overview.me.role === 'owner';
  return <><MobileHeader title={person.display_name} back="/p/family" /><div className="mobile-content stack">
    {person.role === 'owner' && <Badge>{copy.owner}</Badge>}
    <label className="checkbox"><input type="checkbox" checked={request} disabled={!owner && !self} onChange={(event) => setRequest(event.target.checked)} />{copy.canRequest}</label>
    <label className="checkbox"><input type="checkbox" checked={drive} disabled={!owner && !self} onChange={(event) => setDrive(event.target.checked)} />{copy.canDrive}</label>
    {(self || owner) && <Button disabled={pending} onClick={() => { void run('set_member_roles', { p_member_id: id, p_can_drive: drive, p_can_request: request }, copy.saved); }}>{copy.save}</Button>}
    {owner && !self && <><Button variant="outline" onClick={() => setConfirm('transfer')}>{copy.transferOwner}</Button><Button variant="plain" onClick={() => setConfirm('remove')}>{copy.removeMember}</Button></>}
  </div>{confirm && <Confirm danger={confirm === 'remove'} title={confirm === 'remove' ? copy.removeMemberQuestion : copy.transferOwnerQuestion} confirmLabel={confirm === 'remove' ? copy.removeMember : copy.transferOwner} close={() => setConfirm(null)} action={async () => {
    const result = await run(confirm === 'remove' ? 'remove_member' : 'transfer_owner', { p_member_id: id }, copy.saved);
    if (result) navigate('/p/family');
    return result;
  }} />}</>;
}

function RiderEdit({ overview, id }: { overview: Overview; id: string }) {
  const existing = overview.riders.find((row) => row.id === id && !row.archived_at);
  const [name, setName] = useState(existing?.display_name ?? '');
  const [phone, setPhone] = useState(existing?.phone_e164 ?? '');
  const [kind, setKind] = useState<'child' | 'adult'>(existing?.kind ?? 'child');
  const [year, setYear] = useState(existing?.birth_year?.toString() ?? '');
  const [consent, setConsent] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const { run, pending } = useLiveMutation();
  const navigate = useNavigate();
  if (id !== 'new' && !existing) return <Navigate to="/p/family" replace />;
  const devices = existing?.devices ?? overview.devices.filter((row) => row.rider_id === id);
  return <><MobileHeader title={existing?.display_name ?? copy.addRider} back="/p/family" /><div className="mobile-content stack">
    <form className="stack edit-form" onSubmit={async (event) => {
      event.preventDefault();
      const normalized = e164(phone);
      if (normalized == null) return;
      const saved = await run(existing ? 'update_rider' : 'add_rider', { p_display_name: name.trim(), p_phone_e164: existing ? normalized : normalized || undefined,
        ...(existing ? { p_rider_id: id } : { p_kind: kind, p_birth_year: year ? Number(year) : undefined, p_consent: consent ? privacyVersion : undefined }) }, copy.saved);
      if (saved && !existing) {
        const rider = saved.rider as { id?: string } | undefined;
        if (rider?.id) navigate(`/p/riders/${rider.id}`);
      }
    }}>
      <label className="field">{copy.name}<input required value={name} maxLength={20} placeholder={copy.namePlaceholder} onChange={(event) => setName(event.target.value)} /></label>
      <label className="field">{copy.phone}<input type="tel" maxLength={22} value={phone} placeholder={copy.phoneFormat} onChange={(event) => setPhone(event.target.value)} /></label>
      {!existing && <>
        <div className="chips"><button type="button" className="chip" aria-pressed={kind === 'child'} onClick={() => setKind('child')}>{copy.child}</button><button type="button" className="chip" aria-pressed={kind === 'adult'} onClick={() => setKind('adult')}>{copy.adult}</button></div>
        <label className="field">{copy.birthYear}<input type="number" min="1900" max={new Date().getFullYear()} value={year} onChange={(event) => setYear(event.target.value)} /></label>
        {kind === 'child' ? <label className="checkbox"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />{copy.consentGuardian}</label> : <p className="small muted">{copy.consentAdultLater}</p>}
      </>}
      <Button type="submit" disabled={pending || !name.trim() || e164(phone) == null || !existing && kind === 'child' && !consent}>{existing ? copy.save : copy.riderAdd}</Button>
    </form>
    {existing && <>
      <h2>{copy.simpleLink}</h2>{devices.filter((row) => !row.revoked_at).map((row) => <Row key={row.id} title={deviceLabel(row.user_agent)} icon={<Smartphone size={18} />} caption={row.last_seen_at ? clock(Date.parse(row.last_seen_at)) : undefined} trailing={<Button variant="outline" onClick={() => setConfirm(row.id)}>{copy.disconnect}</Button>} />)}
      <InvitePanel riderId={id} phone={existing.phone_e164} />
      <Button variant="plain" onClick={() => setConfirm('archive')}>{copy.riderArchive}</Button>
    </>}
  </div>{confirm && <Confirm danger title={confirm === 'archive' ? copy.riderArchiveQuestion : copy.riderDisconnectQuestion} confirmLabel={confirm === 'archive' ? copy.riderArchive : copy.disconnect} close={() => setConfirm(null)} action={async () => {
    const result = await run(confirm === 'archive' ? 'archive_rider' : 'revoke_rider_device', confirm === 'archive' ? { p_rider_id: id } : { p_device_id: confirm });
    if (result && confirm === 'archive') navigate('/p/family');
    return result;
  }} />}</>;
}
function deviceLabel(agent?: string | null) {
  if (/iPhone|iPad/.test(agent ?? '')) return 'iPhone / iPad';
  if (/Android/.test(agent ?? '')) return 'Android';
  return copy.connectedPhone;
}

const placeKinds = ['home', 'academy', 'school', 'other'] as const;
function CoordinatesField({ coords, onChange }: { coords?: Coordinates; onChange: (value: Coordinates | undefined) => void }) {
  const [input, setInput] = useState([coords ? String(coords.lat) : '', coords ? String(coords.lng) : '']);
  function update(lat: string, lng: string) {
    setInput([lat, lng]);
    if (!lat.trim() || !lng.trim()) { onChange(undefined); return; }
    const next = { lat: Number(lat), lng: Number(lng) };
    onChange(Number.isFinite(next.lat) && Math.abs(next.lat) <= 90 && Number.isFinite(next.lng) && Math.abs(next.lng) <= 180 ? next : undefined);
  }
  return <div className="coordinate-inputs"><label className="field">{copy.coordinateLatitude}<input inputMode="decimal" value={input[0]} onChange={(event) => update(event.target.value, input[1])} /></label><label className="field">{copy.coordinateLongitude}<input inputMode="decimal" value={input[1]} onChange={(event) => update(input[0], event.target.value)} /></label></div>;
}

function PositionControl({ coords, setCoords, onPlace }: { coords?: Coordinates; setCoords: (value: Coordinates | undefined) => void; onPlace?: (place: PlaceResult) => void }) {
  const key = useMapKey();
  const toast = useToast();
  const [term, setTerm] = useState('');
  const [found, setFound] = useState<PlaceResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [coordsKey, setCoordsKey] = useState(0);
  const [map, setMap] = useState(false);
  async function locate() {
    setBusy(true);
    try { const value = await browserPosition(); setCoords(value); setCoordsKey((previous) => previous + 1); setMap(true); }
    catch (error) { toast(describeError(error)); }
    finally { setBusy(false); }
  }
  return <div className="stack">
    {key && onPlace && <><label className="field guardian-search"><Search size={19} /><input type="search" aria-label={copy.mapSearch} placeholder={copy.mapSearch} value={term} maxLength={80} onChange={(event) => setTerm(event.target.value)} /></label>
      <Button variant="outline" disabled={busy || term.trim().length < 2} onClick={async () => { setBusy(true); try { setFound(await searchPlaces(key, term.trim())); } catch (error) { toast(describeError(error)); } finally { setBusy(false); } }}>{copy.search}</Button>
      {found?.length === 0 && <p className="muted">{copy.noSearch}</p>}{found?.map((row) => <Row key={row.id} title={row.name} caption={row.address} icon={<MapPin size={18} />} onClick={() => { onPlace(row); setFound(null); setCoordsKey((previous) => previous + 1); setMap(true); }} />)}
    </>}
    <Button variant="outline" disabled={busy} onClick={() => { void locate(); }}><MapPin size={17} />{copy.useGeo}</Button>
    {key && !coords && !map && <Button variant="plain" onClick={() => setMap(true)}>{copy.onMap}</Button>}
    {(coords || map) && <MapPreview live coords={coords ?? { lat: 36.45, lng: 127.9 }} onMove={(next) => { setCoords(next); setCoordsKey((previous) => previous + 1); }} />}
    {!key && <p className="small muted">{copy.mapUnavailableHint}</p>}
    <CoordinatesField key={coordsKey} coords={coords} onChange={setCoords} />
  </div>;
}

function PlaceEdit({ overview, id }: { overview: Overview; id: string }) {
  const place = overview.places.find((row) => row.id === id && !row.archived_at);
  const routeState = useLocation().state as { coords?: Coordinates; fromPickup?: string } | null;
  const [name, setName] = useState(place?.label ?? '');
  const [kind, setKind] = useState(place?.kind ?? 'other');
  const [coords, setCoords] = useState<Coordinates | undefined>(place ?? (routeState?.coords && isCoordinates(routeState.coords) ? routeState.coords : undefined));
  const [radius, setRadius] = useState(place?.radius_m ?? 150);
  const [point, setPoint] = useState<string | null>(null);
  const [archive, setArchive] = useState(false);
  const { run, pending } = useLiveMutation();
  const navigate = useNavigate();
  if (id !== 'new' && !place) return <Navigate to="/p/family" replace />;
  const points = overview.pickup_points.filter((row) => row.place_id === id && !row.archived_at);
  const back = routeState?.fromPickup && /^[\w-]+$/.test(routeState.fromPickup) ? `/p/pickups/${routeState.fromPickup}/location` : '/p/family';
  return <><MobileHeader back={back} className="guardian-back-header" /><div className="mobile-content stack guardian-place-editor"><h1>{place ? copy.placeEdit : copy.placeAdd}</h1>
    <form className="stack edit-form" onSubmit={async (event) => {
      event.preventDefault();
      if (!coords) return;
      const result = await run('upsert_place', { p_place_id: place?.id, p_label: name.trim(), p_kind: kind, p_lat: coords.lat, p_lng: coords.lng, p_radius_m: radius }, copy.saved);
      if (result) navigate(routeState?.fromPickup && /^[\w-]+$/.test(routeState.fromPickup) ? `/p/pickups/${routeState.fromPickup}/location` : '/p/family');
    }}>
      <PositionControl coords={coords} setCoords={setCoords} onPlace={(row) => { setCoords(row); if (!name.trim()) setName(row.name.slice(0, 40)); }} />
      <label className="field">{copy.name}<input required value={name} maxLength={40} onChange={(event) => setName(event.target.value)} /></label>
      <fieldset><legend>{copy.kind}</legend><div className="chips">{placeKinds.map((item, index) => <button type="button" className="chip" aria-pressed={item === kind} key={item} onClick={() => setKind(item)}>{copy.placeKinds[index]}</button>)}</div></fieldset>
      <label className="field">{copy.radius}<select value={radius} onChange={(event) => setRadius(Number(event.target.value))}>{[...new Set([50, 100, 150, 300, radius])].sort((a, b) => a - b).map((value) => <option value={value} key={value}>{value}m</option>)}</select></label>
      <Button type="submit" disabled={pending || !name.trim() || !coords}>{copy.save}</Button>
    </form>
    {place && <section className="stack"><h2>{copy.pickupPoint}</h2>{points.map((row) => <Row key={row.id} title={row.label} caption={row.note} onClick={() => setPoint(row.id)} />)}
      <Button variant="outline" onClick={() => setPoint('new')}>{copy.pointAdd}</Button><Button variant="plain" onClick={() => setArchive(true)}>{copy.placeArchive}</Button></section>}
  </div>{archive && <Confirm title={copy.placeArchiveQuestion} confirmLabel={copy.placeArchive} close={() => setArchive(false)} danger action={async () => {
    const result = await run('archive_place', { p_place_id: id }); if (result) navigate('/p/family'); return result;
  }} />}{point && place && <PointEdit key={point} place={place} point={points.find((row) => row.id === point)} close={() => setPoint(null)} />}</>;
}

function PointEdit({ place, point, close }: { place: Overview['places'][number]; point?: Overview['pickup_points'][number]; close: () => void }) {
  const [coords, setCoords] = useState<Coordinates | undefined>(point ?? place);
  const [label, setLabel] = useState(point?.label ?? '');
  const [note, setNote] = useState(point?.note ?? '');
  const [archive, setArchive] = useState(false);
  const { run, pending } = useLiveMutation();
  if (archive && point) return <Confirm title={copy.pointRemoveQuestion} confirmLabel={copy.pointRemove} close={() => setArchive(false)} danger action={async () => { const result = await run('archive_pickup_point', { p_pickup_point_id: point.id }); if (result) close(); return false; }} />;
  return <Sheet title={point ? copy.pickupPoint : copy.pointAdd} close={close}><form className="stack" onSubmit={async (event) => {
    event.preventDefault();
    if (!coords) return;
    const result = await run('upsert_pickup_point', { p_pickup_point_id: point?.id, p_place_id: place.id, p_label: label.trim(), p_note: note.trim() || null, p_lat: coords.lat, p_lng: coords.lng }, copy.saved);
    if (result) close();
  }}>
    <PositionControl coords={coords} setCoords={setCoords} /><label className="field">{copy.name}<input maxLength={20} value={label} onChange={(event) => setLabel(event.target.value)} required /></label>
    <label className="field">{copy.mapNote}<input maxLength={40} value={note} onChange={(event) => setNote(event.target.value)} /></label>
    <Button type="submit" disabled={pending || !label.trim() || !coords}>{copy.save}</Button>{point && <Button variant="plain" onClick={() => setArchive(true)}>{copy.pointRemove}</Button>}
  </form></Sheet>;
}

function RoutineList({ overview, state }: Props) {
  const { run, pending } = useLiveMutation();
  const [disableId, setDisableId] = useState<string>();
  const now = useClock(state);
  async function toggle(id: string, active: boolean, cancel = false) {
    const routine = overview.routines.find((row) => row.id === id && !row.archived_at);
    if (!routine) return;
    const updated = await run('upsert_routine', {
      p_routine_id: id, p_rider_id: routine.rider_id, p_rider_member_id: routine.rider_member_id,
      p_place_id: routine.place_id, p_pickup_point_id: routine.pickup_point_id, p_weekdays: routine.weekdays,
      p_time_local: routine.time_local, p_notify_before_min: routine.notify_before_min, p_default_assignee_member_id: routine.default_assignee_member_id,
      p_default_vehicle_id: routine.default_vehicle_id, p_start_date: routine.start_date, p_end_date: routine.end_date, p_active: active, p_cancel_future: cancel,
    }, copy.saved);
    if (updated) { if (active) await run('ensure_occurrences', { p_days: 2 }); setDisableId(undefined); }
  }
  return <><MobileHeader title={copy.app}><HeaderBell /></MobileHeader><div className="mobile-content guardian-routines"><p className="muted">{dateLabel(now)}</p><div className="guardian-section-heading"><h2>{copy.routine}</h2><Link className="button button--plain" to="/p/routines/new">{copy.add}</Link></div>
    {state.routines.filter((routine) => overview.routines.some((row) => row.id === routine.id && !row.archived_at)).map((routine) => <RoutineListRow key={routine.id} id={routine.id} name={nameOf(state, routine.requester.id)} schedule={`${routine.days.map((day) => copy.weekdays[day]).join(' ')} ${routine.time}`} place={state.places.find((place) => place.id === routine.placeId)?.label ?? copy.location} assignee={nameOf(state, routine.assigneeId)} car={state.vehicles?.find((car) => car.id === routine.vehicleId)?.name} enabled={routine.enabled} pending={pending} toggle={() => {
      if (routine.enabled) setDisableId(routine.id); else void toggle(routine.id, true);
    }} />)}
    {!state.routines.length && <Placeholder text={copy.noRoutines} />}
  </div>{disableId && <Sheet title={copy.routineDisableDesc} close={() => setDisableId(undefined)}><div className="stack"><Button disabled={pending} onClick={() => { void toggle(disableId, false, true); }}>{copy.routineDisableTogether}</Button><Button variant="secondary" disabled={pending} onClick={() => { void toggle(disableId, false); }}>{copy.routineKeep}</Button><Button variant="plain" onClick={() => setDisableId(undefined)}>{copy.back}</Button></div></Sheet>}</>;
}

function RoutineEdit({ overview, id }: { overview: Overview; id: string }) {
  const routine = overview.routines.find((row) => row.id === id && !row.archived_at);
  const requesters = [...overview.riders.filter((row) => !row.archived_at).map((row) => ({ ...row, kind: 'rider' as const })),
    ...overview.members.filter((row) => !row.left_at && row.can_request).map((row) => ({ ...row, kind: 'member' as const }))];
  const [who, setWho] = useState(routine?.rider_id ?? routine?.rider_member_id ?? requesters[0]?.id ?? '');
  const [place, setPlace] = useState(routine?.place_id ?? '');
  const [point, setPoint] = useState(routine?.pickup_point_id ?? '');
  const [days, setDays] = useState(routine?.weekdays ?? 21);
  const [time, setTime] = useState(routine?.time_local.slice(0, 5) ?? '17:30');
  const [before, setBefore] = useState(routine?.notify_before_min ?? 20);
  const [driver, setDriver] = useState(routine?.default_assignee_member_id ?? '');
  const [car, setCar] = useState(routine?.default_vehicle_id ?? '');
  const [start, setStart] = useState(routine?.start_date ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(Date.now()));
  const [end, setEnd] = useState(routine?.end_date ?? '');
  const [confirm, setConfirm] = useState<'archive' | 'disable' | null>(null);
  const { run, pending } = useLiveMutation();
  const navigate = useNavigate();
  if (id !== 'new' && !routine) return <Navigate to="/p/routines" replace />;
  const requester = requesters.find((row) => row.id === who);
  const active = routine?.is_active ?? routine?.active ?? true;
  const drivers = overview.members.filter((row) => row.can_drive && !row.left_at && row.id !== who);
  const cars = overview.vehicles.filter((row) => !row.revoked_at && row.current_driver_member_id === driver);
  const disabled = !requester || !place || !days || !time || !start || Boolean(end && end < start);
  async function save(p_active = active, p_cancel_future = false) {
    if (!requester || disabled) return null;
    const result = await run('upsert_routine', { p_routine_id: routine?.id, p_rider_id: requester.kind === 'rider' ? who : null, p_rider_member_id: requester.kind === 'member' ? who : null,
      p_place_id: place, p_pickup_point_id: point || null, p_weekdays: days, p_time_local: time, p_notify_before_min: before,
      p_default_assignee_member_id: driver || null, p_default_vehicle_id: car || null, p_start_date: start, p_end_date: end || null, p_active, p_cancel_future }, copy.saved);
    if (result) {
      if (p_active) await run('ensure_occurrences', { p_days: 2 });
      navigate('/p/routines');
    }
    return result;
  }
  return <><MobileHeader title={routine ? copy.routineEdit : copy.routineAdd} back="/p/routines" className="guardian-detail-header" /><div className="mobile-content">
    <form className="stack edit-form guardian-routine-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label className="field">{copy.person}<select value={who} onChange={(event) => { setWho(event.target.value); if (driver === event.target.value) { setDriver(''); setCar(''); } }}>{requesters.map((row) => <option key={row.id} value={row.id}>{row.display_name}</option>)}</select></label>
      <label className="field">{copy.location}<select required value={place} onChange={(event) => { setPlace(event.target.value); setPoint(''); }}><option value="">{copy.selectFirst}</option>{overview.places.filter((row) => !row.archived_at).map((row) => <option key={row.id} value={row.id}>{row.label}</option>)}</select></label>
      {!overview.places.length && <Link className="button button--outline" to="/p/places/new">{copy.placeAdd}</Link>}
      {overview.pickup_points.some((row) => row.place_id === place && !row.archived_at) && <label className="field">{copy.pickupPoint}<select value={point} onChange={(event) => setPoint(event.target.value)}><option value="">{copy.noAssignee}</option>{overview.pickup_points.filter((row) => row.place_id === place && !row.archived_at).map((row) => <option key={row.id} value={row.id}>{row.label}</option>)}</select></label>}
      <fieldset className="guardian-weekdays"><legend>{copy.days}</legend><div className="chips">{copy.weekdays.map((day, index) => <button type="button" className="chip" key={day} aria-pressed={Boolean(days & (1 << index))} onClick={() => setDays((value) => value ^ (1 << index))}>{day}</button>)}</div></fieldset>
      <label className="field">{copy.time}<input required type="time" value={time} onChange={(event) => setTime(event.target.value)} /></label>
      <label className="field">{copy.notifyBefore}<select value={before} onChange={(event) => setBefore(Number(event.target.value))}>{[...new Set([5, 10, 20, 30, 60, 120, before])].sort((a, b) => a - b).map((value) => <option key={value} value={value}>{copy.minutesBefore(value)}</option>)}</select></label>
      <label className="field">{copy.defaultAssignee}<select value={driver} onChange={(event) => { setDriver(event.target.value); setCar(''); }}><option value="">{copy.noAssignee}</option>{drivers.map((row) => <option key={row.id} value={row.id}>{row.display_name}</option>)}</select></label>
      <label className="field">{copy.defaultVehicle}<select value={car} onChange={(event) => setCar(event.target.value)}><option value="">{copy.noVehicle}</option>{cars.map((row) => <option key={row.id} value={row.id}>{row.nickname}</option>)}</select></label>
      <label className="field">{copy.fromDate}<input type="date" required value={start} onChange={(event) => setStart(event.target.value)} /></label>
      <label className="field">{copy.untilDate}<input type="date" min={start} value={end} onChange={(event) => setEnd(event.target.value)} /></label>
      {routine && <p className="small muted">{copy.futureOnly}</p>}
      <Button type="submit" disabled={disabled || pending}>{routine ? copy.save : copy.routineAdd}</Button>
      {routine && <><Button variant="secondary" disabled={pending} onClick={() => { if (active) setConfirm('disable'); else void save(true); }}>{active ? copy.routineDisable : copy.routineOn}</Button><Button variant="plain" disabled={pending} onClick={() => setConfirm('archive')}>{copy.routineDelete}</Button></>}
    </form>
  </div>{confirm === 'disable' && <Sheet title={copy.routineDisableDesc} close={() => setConfirm(null)}><div className="stack"><Button disabled={pending} onClick={() => { void save(false, true); }}>{copy.routineDisableTogether}</Button><Button variant="secondary" disabled={pending} onClick={() => { void save(false); }}>{copy.routineKeep}</Button><Button variant="plain" onClick={() => setConfirm(null)}>{copy.back}</Button></div></Sheet>}
    {confirm === 'archive' && <Confirm title={copy.routineDeleteDesc} confirmLabel={copy.routineDelete} close={() => setConfirm(null)} danger action={async () => { const result = await run('archive_routine', { p_routine_id: id }); if (result) navigate('/p/routines'); return result; }} />}</>;
}

function VehiclePair({ overview }: { overview: Overview }) {
  const [params] = useSearchParams();
  const [code, setCode] = useState((params.get('code') ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6));
  const [nickname, setNickname] = useState('');
  const drivers = overview.members.filter((row) => row.can_drive && !row.left_at);
  const [driver, setDriver] = useState(drivers.find((row) => row.id === overview.me.id)?.id ?? drivers[0]?.id ?? '');
  const { run, pending } = useLiveMutation();
  const navigate = useNavigate();
  return <><MobileHeader back="/p/family" className="guardian-back-header" /><div className="mobile-content guardian-flow guardian-vehicle-pair"><h1>{copy.vehiclesPairTitle}</h1><p className="muted">{copy.vehiclesPairDescription}</p>
    <form className="stack guardian-form-grow" onSubmit={async (event) => {
      event.preventDefault();
      const result = await run('vehicle_pair_confirm', { p_code: code, p_nickname: nickname.trim(), p_current_driver_member_id: driver });
      if (result) navigate('/p/family');
    }}>
      <label className="field guardian-vehicle-code-field">{copy.codeLabel}<input maxLength={7} value={code.length > 3 ? `${code.slice(0, 3)}-${code.slice(3)}` : code} onChange={(event) => setCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))} required /></label>
      <label className="field">{copy.carNickname}<input maxLength={20} value={nickname} onChange={(event) => setNickname(event.target.value)} required placeholder={copy.carName} /></label>
      <fieldset><legend>{copy.currentDriver}</legend><div className="chips">{drivers.map((row) => <button type="button" className="chip" key={row.id} aria-pressed={driver === row.id} onClick={() => setDriver(row.id)}>{row.display_name}</button>)}</div></fieldset>
      <div className="stack guardian-flow-actions"><Button type="submit" disabled={pending || code.length !== 6 || !nickname.trim() || !driver}>{copy.connect}</Button></div>
    </form>
  </div></>;
}

function VehicleDetail({ overview, today, vehicle, state }: { overview: Overview; today?: Today; vehicle: VehicleRow; state: DemoState }) {
  const [name, setName] = useState(vehicle.nickname);
  const [driver, setDriver] = useState(vehicle.current_driver_member_id ?? '');
  const [revoke, setRevoke] = useState(false);
  const { run, pending } = useLiveMutation();
  const navigate = useNavigate();
  const range = vehicle.state ?? vehicle.vehicle_state;
  const alerts = today?.alerts.filter((alert) => alert.vehicle_id === vehicle.id && !alert.resolved_at) ?? [];
  return <><MobileHeader back="/p/family" className="guardian-back-header" /><div className="mobile-content stack guardian-vehicle-page">
    <div className="guardian-section-heading"><h1>{vehicle.nickname}</h1>{range?.is_demo_value && <Badge tone="neutral">{copy.demoValue}</Badge>}</div>
    <section><h2>{copy.rangeTitle}</h2><p className="range-number">{range?.range_km == null ? copy.noRange : `${range.range_km}km`}</p>
    {range?.soc_pct != null && <p>{copy.batteryPercent(range.soc_pct)}</p>}
    {range?.fuel_pct != null && <p>{copy.fuelPercent(range.fuel_pct)}</p>}
    {range?.is_stale && <Badge tone="neutral">{copy.staleValue}</Badge>}
    {range?.collected_at && <p className="muted">{copy.collectionTime} {clock(Date.parse(range.collected_at))}</p>}
    </section>
    <form className="stack edit-form" onSubmit={(event) => { event.preventDefault(); void run('update_vehicle', { p_vehicle_id: vehicle.id, p_nickname: name.trim(), p_current_driver_member_id: driver || undefined }, copy.saved); }}>
      <label className="field">{copy.carNickname}<input value={name} required maxLength={20} onChange={(event) => setName(event.target.value)} /></label>
      <label className="field">{copy.currentDriver}<select value={driver} onChange={(event) => setDriver(event.target.value)}><option value="" disabled>{copy.noAssignee}</option>{overview.members.filter((row) => row.can_drive && !row.left_at).map((row) => <option key={row.id} value={row.id}>{row.display_name}</option>)}</select></label>
      <Button type="submit" disabled={pending || !name.trim()}>{copy.save}</Button>
    </form>
    <h2>{copy.todaySchedule}</h2>{state.pickups.filter((pickup) => pickup.vehicleId === vehicle.id).map((pickup) => <Row key={pickup.id} to={`/p/pickups/${pickup.id}`} title={`${clock(pickup.wantedAt)} ${nameOf(state, pickup.requester.id)}`} caption={pickup.destination.label} />)}
    {alerts.map((alert) => <div key={alert.id} className="guardian-range-warning stack"><h3><CircleAlert size={21} />{copy.rangeInsufficient}</h3>{alert.required_km != null && <p>{copy.rangeNeed(alert.required_km)}</p>}{alert.range_km != null && <p>{copy.rangeCurrent(alert.range_km)}</p>}
      {!alert.acknowledged_at && <Button disabled={pending} onClick={() => { void run('ack_vehicle_alert', { p_alert_id: alert.id }); }}>{copy.confirm}</Button>}
    </div>)}
    <Button variant="plain" onClick={() => setRevoke(true)}>{copy.disconnect}</Button>
  </div>{revoke && <Confirm title={copy.carDisconnectQuestion} confirmLabel={copy.disconnect} close={() => setRevoke(false)} danger action={async () => { const result = await run('revoke_vehicle', { p_vehicle_id: vehicle.id }); if (result) navigate('/p/family'); return result; }} />}</>;
}

function LiveSettings({ overview }: { overview: Overview }) {
  const client = useClient();
  const query = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const { run, pending } = useLiveMutation();
  const [name, setName] = useState(overview.me.display_name);
  const [phone, setPhone] = useState(overview.me.phone_e164 ?? '');
  const [sms, setSms] = useState(overview.me.sms_opt_in ?? false);
  const [family, setFamily] = useState(overview.family.name);
  const [info, setInfo] = useState<'privacy' | 'notice' | 'consent' | null>(null);
  const [confirm, setConfirm] = useState<'leave' | 'delete' | null>(null);
  const owner = overview.me.role === 'owner';
  const hasOtherMembers = overview.members.some((person) => person.id !== overview.me.id && !person.left_at);
  async function logout() {
    await unsubscribePush(client, true).catch(() => {});
    const { error } = await client.supabase.auth.signOut({ scope: 'local' });
    if (error) { toast(copy.genericError); return false; }
    query.clear(); navigate('/p/login', { replace: true }); return true;
  }
  async function deleteAccount() {
    if (owner && hasOtherMembers) { toast(copy.ownerTransferRequired); return false; }
    const lastOwner = owner && !hasOtherMembers;
    const { data, error } = await client.supabase.functions.invoke('delete-account', { body: { confirm_family_delete: lastOwner } });
    if (error || data?.ok !== true) { toast(copy.deleteAccountError); return false; }
    return logout();
  }
  return <><MobileHeader title={copy.settings} back="/p/family" /><div className="mobile-content stack family-page guardian-settings-list">
    <section className="stack"><h2>{copy.info}</h2><form className="stack edit-form" onSubmit={(event) => { event.preventDefault(); const normalized = e164(phone); if (normalized != null) void run('update_me', { p_display_name: name.trim(), p_phone_e164: normalized, p_sms_opt_in: Boolean(normalized && sms) }, copy.saved); }}>
      <label className="field">{copy.name}<input required maxLength={20} value={name} onChange={(event) => setName(event.target.value)} /></label><label className="field">{copy.phone}<input type="tel" maxLength={22} value={phone} onChange={(event) => setPhone(event.target.value)} /></label>
      <label className="checkbox"><input type="checkbox" checked={sms} disabled={!e164(phone)} onChange={(event) => setSms(event.target.checked)} />{copy.messageNotification}</label><Button type="submit" disabled={pending || !name.trim() || e164(phone) == null}>{copy.save}</Button>
    </form></section>
    <section><h2>{copy.notification}</h2><Row icon={<Bell size={18} />} title={copy.notifications} to="/p/notifications" /><Row icon={<Smartphone size={18} />} title={copy.installHelp} to="/p/install" /></section>
    <section><h2>{copy.privacy}</h2><Row icon={<Shield size={18} />} title={copy.privacyPolicy} onClick={() => setInfo('privacy')} /><Row icon={<Shield size={18} />} title={copy.consentHistory} onClick={() => setInfo('consent')} /></section>
    <section className="stack"><h2>{copy.family}</h2>{overview.me.role === 'owner' ? <form className="stack" onSubmit={(event) => { event.preventDefault(); void run('update_family', { p_name: family.trim() }, copy.saved); }}><label className="field">{copy.familyName}<input maxLength={40} value={family} onChange={(event) => setFamily(event.target.value)} required /></label><Button type="submit" variant="outline" disabled={pending || !family.trim()}>{copy.save}</Button></form> : <Row title={copy.leaveFamily} onClick={() => setConfirm('leave')} />}</section>
    <section><Row title={copy.logOut} onClick={() => { void logout(); }} /><Row title={copy.deleteAccount} onClick={() => setConfirm('delete')} /><Row icon={<CircleHelp size={18} />} title={copy.notice} onClick={() => setInfo('notice')} />
      {import.meta.env.VITE_DEMO === 'true' && overview.me.role === 'owner' && overview.family.is_demo && <Row title={copy.demoTools} to="/p/demo" />}</section>
  </div>{info && <Sheet title={info === 'privacy' ? copy.privacyPolicy : info === 'consent' ? copy.consentHistory : copy.notice} close={() => setInfo(null)}>
    {info === 'consent' ? <><p>{overview.me.location_consented_at ? copy.consentRecorded(new Date(overview.me.location_consented_at).toLocaleDateString('ko-KR')) : copy.noConsentRecord}</p>{overview.consents.map((row, index) => <Row key={index} title={row.purpose === 'privacy' ? copy.privacyPolicy : row.purpose === 'rider_location' ? copy.consentGuardian : copy.consentSelf} trailing={row.granted_at ? new Date(row.granted_at).toLocaleDateString('ko-KR') : row.version} />)}</> : <p>{info === 'privacy' ? copy.livePrivacy : copy.noticeDetails}</p>}
    <Button onClick={() => setInfo(null)}>{copy.confirm}</Button>
  </Sheet>}{confirm && <Confirm title={confirm === 'leave' ? copy.leaveQuestion : owner && !hasOtherMembers ? copy.deleteLastFamilyQuestion : copy.deleteAccountQuestion} confirmLabel={confirm === 'leave' ? copy.leaveFamily : copy.deleteAccount} close={() => setConfirm(null)} danger action={async () => {
    if (confirm === 'delete') return deleteAccount();
    const result = await run('leave_family');
    if (result) { await unsubscribePush(client, true).catch(() => {}); query.clear(); navigate('/p/onboarding', { replace: true }); }
    return result;
  }} />}</>;
}

function LiveDemoTools({ overview }: { overview: Overview }) {
  const [scale, setScale] = useState(overview.family.demo_time_scale ?? 1);
  const [reset, setReset] = useState(false);
  const { run, pending } = useLiveMutation();
  if (import.meta.env.VITE_DEMO !== 'true' || overview.me.role !== 'owner' || !overview.family.is_demo) return <Navigate to="/p/" replace />;
  return <><MobileHeader title={copy.demoTools} back="/p/settings" /><div className="mobile-content stack">
    <Badge>{copy.demoLabel}</Badge>
    <label className="field">{copy.timeScale}<input type="number" min="1" max="60" value={scale} onChange={(event) => setScale(Number(event.target.value))} /></label>
    <Button disabled={pending || !Number.isInteger(scale) || scale < 1 || scale > 60} onClick={() => { void run('demo_set_time_scale', { p_scale: scale }, copy.saved); }}>{copy.save}</Button>
    <Button variant="outline" disabled={pending} onClick={() => { void run('demo_run_now', {}, copy.saved); }}>{copy.advanceTime}</Button>
    <Button variant="plain" disabled={pending} onClick={() => setReset(true)}>{copy.resetTitle}</Button>
  </div>{reset && <Confirm title={copy.resetQuestion} confirmLabel={copy.reset} close={() => setReset(false)} danger action={() => run('demo_reset', {}, copy.resetDone)} />}</>;
}

export function LiveManagement(props: Props) {
  const { overview, path } = props;
  if (path === '/p/routines') return <RoutineList {...props} />;
  if (path === '/p/family') return <Family {...props} />;
  if (path === '/p/settings') return <LiveSettings overview={overview} />;
  if (path === '/p/demo') return <LiveDemoTools overview={overview} />;
  if (path === '/p/family/invite') return <><MobileHeader title={copy.app} back="/p/family" className="guardian-brand-header" /><div className="mobile-content guardian-account guardian-invite-page"><h2>{copy.guardianInvite}</h2><InvitePanel /></div></>;
  if (path === '/p/vehicles/pair') return <VehiclePair overview={overview} />;
  const match = path.match(/^\/p\/(routines|members|riders|children|places|vehicles)\/([^/]+)$/);
  if (!match) return <Navigate to="/p/" replace />;
  const [, section, id] = match;
  if (section === 'routines') return <RoutineEdit key={id} overview={overview} id={id} />;
  if (section === 'members') return <MemberEdit key={id} overview={overview} id={id} />;
  if (section === 'riders' || section === 'children') return <RiderEdit key={id} overview={overview} id={id} />;
  if (section === 'places') return <PlaceEdit key={id} overview={overview} id={id} />;
  const vehicle = overview.vehicles.find((row) => row.id === id && !row.revoked_at);
  return vehicle ? <VehicleDetail key={id} vehicle={vehicle} overview={overview} today={props.today} state={props.state} /> : <Navigate to="/p/family" replace />;
}
