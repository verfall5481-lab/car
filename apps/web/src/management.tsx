import { useState } from 'react';
import { Bell, CalendarDays, CarFront, Check, CircleAlert, CircleHelp, Clock3, Map, MapPin, Plus, QrCode, Search, Settings, Shield, Smartphone, UserRound, Users } from 'lucide-react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { isActivePickup, isCoordinates } from '@deriro/contracts';
import { clock, copy, dateLabel } from './copy.ts';
import { applyDemoAction, changed, demoRoutinesToday, familyId, freshDemo, minute, nameOf, rangeEstimate, routineOccurrence, setDemoTime } from './demo-domain.ts';
import type { DemoState, Person, Routine } from './demo-domain.ts';
import { Badge, Button, HeaderBell, MapPreview, MobileHeader, pinOrigin, Row, Sheet, useClock, useCommit, useToast, uid } from './ui.tsx';
import { DemoFamilySetup, DemoGuardianInstall, DemoGuardianInvite, DemoGuardianLogin, InviteQr } from './guardian-onboarding.tsx';

type Props = { state: DemoState; member: Person };

function Routines({ state }: Props) {
  const now = useClock(state);
  const commit = useCommit();
  const [disable, setDisable] = useState<Routine>();
  async function toggle(routine: Routine, enabled: boolean, cancel = false) {
    const result = await commit((current, stamp) => {
      let next = current;
      if (cancel) {
        for (const pickup of current.pickups) {
          if (current.occurrences[pickup.id] !== routine.id || !['open', 'assigned'].includes(pickup.status)) continue;
          const update = applyDemoAction(next, pickup.id, { kind: 'member', id: current.members[0].id }, { type: 'cancel', expectedVersion: pickup.version, reason: 'skipped' }, stamp);
          if (!update.ok) return { ...update, state: current };
          next = update.state;
        }
      }
      return changed({ ...next, routines: next.routines.map((item) => item.id === routine.id ? { ...item, enabled } : item) });
    });
    if (result.ok) setDisable(undefined);
  }
  return <><MobileHeader title={copy.app}><HeaderBell /></MobileHeader>
    <div className="mobile-content guardian-routines"><p className="muted">{dateLabel(now)}</p><div className="guardian-section-heading"><h2>{copy.routine}</h2><Link className="button button--plain" to="/p/routines/new">{copy.add}</Link></div>
      {state.routines.map((routine) => <RoutineListRow key={routine.id} id={routine.id} name={nameOf(state, routine.requester.id)} schedule={`${routine.days.map((day) => copy.weekdays[day]).join(' ')} ${routine.time}`} place={state.places.find((place) => place.id === routine.placeId)?.label ?? copy.location} assignee={nameOf(state, routine.assigneeId)} car={routine.vehicleId ? state.vehicle.name : undefined} enabled={routine.enabled} toggle={() => {
        if (routine.enabled && state.pickups.some((pickup) => state.occurrences[pickup.id] === routine.id && ['open', 'assigned'].includes(pickup.status))) setDisable(routine);
        else void toggle(routine, !routine.enabled);
      }} />)}
      {!state.routines.length && <p className="muted">{copy.noRoutines}</p>}
    </div>
    {disable && <Sheet title={copy.routineDisableDesc} close={() => setDisable(undefined)}><p className="place-meta"><CalendarDays size={19} />{nameOf(state, disable.requester.id)}, {state.places.find((place) => place.id === disable.placeId)?.label ?? copy.location}</p><div className="stack sheet-actions"><Button onClick={() => { void toggle(disable, false, true); }}>{copy.routineDisableTogether}</Button><Button variant="secondary" onClick={() => { void toggle(disable, false); }}>{copy.routineKeep}</Button></div></Sheet>}
  </>;
}

export function RoutineListRow({ id, name, schedule, place, assignee, car, enabled, toggle, pending }: { id: string; name: string; schedule: string; place: string; assignee?: string; car?: string; enabled: boolean; toggle: () => void; pending?: boolean }) {
  return <article className="guardian-routine-row">
    <Link to={`/p/routines/${id}`} className="guardian-routine-link"><strong>{name}</strong><span><CalendarDays size={17} />{schedule}</span><span><MapPin size={17} />{place}</span><span>{car ? <CarFront size={17} /> : <UserRound size={17} />}{copy.defaultAssignee} {assignee || copy.noAssignee}{car ? `, ${car}` : ''}</span></Link>
    <label className="guardian-routine-toggle"><span>{enabled ? copy.routineOn : copy.routineOff}</span><input type="checkbox" role="switch" className="guardian-switch" aria-label={`${name} ${copy.routine}`} checked={enabled} disabled={pending} onChange={toggle} /></label>
  </article>;
}

function Family({ state, member }: Props) {
  return <><MobileHeader title={copy.family}><Link className="button button--plain" to="/p/settings">{copy.settings}</Link></MobileHeader><div className="mobile-content family-page guardian-family-list">
    <section><h2>{copy.familyMembers}</h2>{state.members.map((person) => <Row key={person.id} icon={<UserRound size={19} />} title={person.id === member.id ? `${person.name} (${copy.me})` : person.name} to={`/p/members/${person.id}`} />)}<Row icon={<Plus size={19} />} title={copy.guardianInvite} to="/p/family/invite" /></section>
    <section><h2>{copy.person}</h2>{state.riders.filter((rider) => !rider.archivedAt).map((rider) => <Row key={rider.id} icon={<UserRound size={19} />} title={rider.name} trailing={rider.connected ? copy.connectedPhone : copy.unconnectedPhone} to={`/p/riders/${rider.id}`} />)}<Row icon={<Plus size={19} />} title={copy.addRider} to="/p/riders/new" /></section>
    <section><h2>{copy.cars}</h2><Row icon={<CarFront size={19} />} title={state.vehicle.name} caption={copy.range(state.vehicle.range)} trailing={`${copy.driver} ${nameOf(state, state.vehicle.currentDriverId)}`} to={`/p/vehicles/${state.vehicle.id}`} /><Row icon={<Plus size={19} />} title={copy.carConnect} to="/p/vehicles/pair" /></section>
    <section><h2>{copy.places}</h2>{state.places.filter((place) => place.archivedAt == null).map((place) => <Row key={place.id} icon={<MapPin size={19} />} title={place.label} to={`/p/places/${place.id}`} />)}<Row icon={<Plus size={19} />} title={copy.placeAdd} to="/p/places/new" /></section>
  </div></>;
}

function SettingsPage({ state, member }: Props) {
  const commit = useCommit();
  const [info, setInfo] = useState<'privacy' | 'notice' | null>(null);
  return <><MobileHeader title={copy.settings} back="/p/family" /><div className="mobile-content family-page guardian-settings-list">
    <section><h2>{copy.info}</h2><Row icon={<UserRound size={18} />} title={copy.guardianNickname} trailing={member.name} to={`/p/members/${member.id}`} />
      <Row icon={<Smartphone size={18} />} title={copy.messageNotification} trailing={<input type="checkbox" role="switch" className="guardian-switch" aria-label={copy.messageNotification} checked={state.sms} onChange={(event) => { const sms = event.target.checked; void commit((current) => changed({ ...current, sms })); }} />} /></section>
    <section><h2>{copy.notification}</h2><Row icon={<Bell size={18} />} title={copy.notifications} trailing={<input type="checkbox" role="switch" className="guardian-switch" aria-label={copy.notifications} checked={state.notifications} onChange={(event) => { const notifications = event.target.checked; void commit((current) => changed({ ...current, notifications })); }} />} />
      <Row icon={<Bell size={18} />} title={copy.testNotification} onClick={() => { void commit((current) => changed(current), copy.testSent); }} /><p className="small muted">{copy.demoNotification}</p></section>
    <section><h2>{copy.privacy}</h2><Row icon={<Shield size={18} />} title={copy.privacyPolicy} onClick={() => setInfo('privacy')} /><Row icon={<CircleHelp size={18} />} title={copy.notice} onClick={() => setInfo('notice')} /></section>
    <section><h2>{copy.family}</h2><Row icon={<Users size={18} />} title={copy.familyName} trailing={state.familyName} to="/p/family" /></section>
    <section><h2>{copy.demo}</h2><Row icon={<Settings size={18} />} title={copy.demoTools} to="/p/demo" /><p className="small muted">{copy.demoOnly} {copy.demoShared}</p></section>
  </div>{info && <Sheet title={info === 'privacy' ? copy.privacyPolicy : copy.notice} close={() => setInfo(null)}><p>{info === 'privacy' ? copy.privacyDetails : copy.noticeDetails}</p><Button onClick={() => setInfo(null)}>{copy.confirm}</Button></Sheet>}</>;
}

function DemoTools({ state }: Props) {
  const commit = useCommit();
  const [advance, setAdvance] = useState(10);
  const [reset, setReset] = useState(false);
  return <><MobileHeader title={copy.demoTools} back="/p/settings" /><div className="mobile-content stack demo-tools">
    <div><Badge>{copy.demoLabel}</Badge><p className="muted">{copy.demoOnly} {copy.demoShared}</p></div>
    <section className="stack"><h2>{copy.demoTime}</h2><label className="field">{copy.demoTime}<select value={advance} onChange={(event) => setAdvance(Number(event.target.value))}>{[5, 10, 30, 60, 180].map((item) => <option key={item} value={item}>{copy.minutesLater(item)}</option>)}</select></label>
      <p className="small muted">{copy.demoTimeHelp}</p><Button onClick={() => { void commit((current, now) => changed(setDemoTime({ ...current, advance: current.advance + advance * minute }, now + advance * minute))); }}>{copy.advanceTime}</Button></section>
    <section className="stack"><h2>{copy.nextRoutine}</h2><p className="muted">{copy.loadRoutineHint}</p><Button variant="outline" disabled={!state.routines.some((routine) => routine.enabled)} onClick={() => {
      void commit((current, now) => {
        const routine = demoRoutinesToday(current, now)[0];
        return routine ? routineOccurrence(current, routine, now, uid()) : { ok: false, state: current, code: 'ROUTINE_ALREADY' };
      }, copy.routineLoaded);
    }}>{copy.loadRoutine}</Button></section>
    <section className="stack"><h2>{copy.resetTitle}</h2><Button variant="outline" onClick={() => setReset(true)}>{copy.reset}</Button></section>
    <section><h2>{copy.demo}</h2><Row title={copy.loginTitle} to="/p/login" /><Row title={copy.setupFamily} to="/p/onboarding" /><Row title={copy.guardianInvite} to="/p/family/invite" /><Row title={copy.notification} to="/p/notifications" /><Row title={copy.carConnect} to="/p/vehicles/pair" /></section>
  </div>{reset && <Sheet title={copy.resetQuestion} close={() => setReset(false)}><div className="stack"><Button variant="danger" onClick={async () => { await commit(() => changed(freshDemo()), copy.resetDone); setReset(false); }}>{copy.reset}</Button><Button variant="secondary" onClick={() => setReset(false)}>{copy.back}</Button></div></Sheet>}</>;
}

export function GuardianManagement(props: Props) {
  const location = useLocation();
  const path = location.pathname.replace(/\/$/, '');
  if (path === '/p/routines') return <Routines {...props} />;
  if (path === '/p/family') return <Family {...props} />;
  if (path === '/p/settings') return <SettingsPage {...props} />;
  if (path === '/p/demo') return <DemoTools {...props} />;
  if (path === '/p/family/invite') return <DemoGuardianInvite />;
  if (path === '/p/login') return <DemoGuardianLogin />;
  if (path === '/p/install') return <DemoGuardianInstall />;
  if (path === '/p/onboarding') return <DemoFamilySetup key="create" {...props} />;
  if (path === '/p/join') return <DemoFamilySetup key="join" {...props} join />;
  if (path === '/p/vehicles/pair') return <DemoVehiclePair {...props} />;
  const match = path.match(/^\/p\/(routines|members|riders|children|places|vehicles)\/([^/]+)$/);
  if (match) {
    const [, section, id] = match;
    if (section === 'routines') return <RoutineEditor key={id} {...props} id={id} />;
    if (section === 'members') return <MemberDetail key={id} {...props} id={id} />;
    if (section === 'riders' || section === 'children') return <RiderDetail key={id} {...props} id={id} />;
    if (section === 'places') return <PlaceEditor key={id} {...props} id={id} />;
    return id === props.state.vehicle.id ? <VehicleDetail {...props} /> : <Navigate to="/p/family" replace />;
  }
  return <Navigate to="/p/" replace />;
}

function RoutineEditor({ state, id }: Props & { id: string }) {
  const navigate = useNavigate();
  const commit = useCommit();
  const existing = state.routines.find((routine) => routine.id === id);
  const [routine, setRoutine] = useState<Routine>(() => existing ?? {
    id: uid(), requester: { kind: 'rider', id: state.riders[0]?.id ?? '' }, placeId: state.places.find((place) => !place.archivedAt)?.id ?? '',
    days: [0, 2, 4], time: '17:30', assigneeId: '', vehicleId: '', before: 20, enabled: true,
  });
  const [confirm, setConfirm] = useState<'disable' | 'delete' | null>(null);
  const driving = state.members.filter((person) => person.canDrive && person.id !== routine.requester.id);
  const people = [...state.riders.map((person) => ({ ...person, type: 'rider' as const })), ...state.members.filter((person) => person.canRequest).map((person) => ({ ...person, type: 'member' as const }))];
  function patch(fields: Partial<Routine>) { setRoutine((previous) => ({ ...previous, ...fields })); }
  async function save(enabled: boolean, cancelOccurrences = false, remove = false) {
    await commit((current, now) => {
      let result = current;
      if (cancelOccurrences) {
        for (const pickup of current.pickups) {
          if (current.occurrences[pickup.id] !== routine.id || !['open', 'assigned'].includes(pickup.status)) continue;
          result = applyDemoAction(result, pickup.id, { kind: 'member', id: current.members[0].id }, { type: 'cancel', expectedVersion: pickup.version, reason: 'skipped' }, now).state;
        }
      }
      return changed({ ...result, routines: remove ? result.routines.filter((item) => item.id !== routine.id) : existing ? result.routines.map((item) => item.id === routine.id ? { ...routine, enabled } : item) : [...result.routines, { ...routine, enabled }] });
    });
    navigate('/p/routines');
  }
  if (id !== 'new' && !existing) return <Navigate to="/p/routines" replace />;
  return <><MobileHeader title={existing ? copy.routineEdit : copy.routineAdd} back="/p/routines" className="guardian-detail-header" /><div className="mobile-content">
    <form className="stack edit-form guardian-routine-form" onSubmit={(event) => { event.preventDefault(); void save(routine.enabled); }}>
      <label className="field">{copy.person}<select value={routine.requester.id} onChange={(event) => { const person = people.find((item) => item.id === event.target.value); if (person) patch({ requester: { id: person.id, kind: person.type }, assigneeId: '', vehicleId: '' }); }}>{people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label>
      <label className="field">{copy.location}<select required value={routine.placeId} onChange={(event) => patch({ placeId: event.target.value })}><option value="">{copy.selectFirst}</option>{state.places.filter((place) => place.archivedAt == null).map((place) => <option key={place.id} value={place.id}>{place.label}</option>)}</select></label>
      <fieldset className="guardian-weekdays"><legend>{copy.days}</legend><div className="chips">{copy.weekdays.map((day, index) => <button type="button" className="chip" key={day} aria-pressed={routine.days.includes(index)} onClick={() => patch({ days: routine.days.includes(index) ? routine.days.filter((value) => value !== index) : [...routine.days, index].sort() })}>{day}</button>)}</div></fieldset>
      <label className="field">{copy.time}<input type="time" required value={routine.time} onChange={(event) => patch({ time: event.target.value })} /></label>
      <label className="field">{copy.notifyBefore}<select value={routine.before} onChange={(event) => patch({ before: Number(event.target.value) })}>{[10, 20, 30, 60].map((value) => <option value={value} key={value}>{copy.minutesBefore(value)}</option>)}</select></label>
      <label className="field">{copy.defaultAssignee}<select value={routine.assigneeId} onChange={(event) => patch({ assigneeId: event.target.value, vehicleId: '' })}><option value="">{copy.noAssignee}</option>{driving.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label>
      <label className="field">{copy.defaultVehicle}<select value={routine.vehicleId} onChange={(event) => patch({ vehicleId: event.target.value })}><option value="">{copy.noVehicle}</option>{routine.assigneeId === state.vehicle.currentDriverId && <option value={state.vehicle.id}>{state.vehicle.name}</option>}</select></label>
      <p className="guardian-form-tip"><CircleAlert size={18} />{copy.futureOnly}</p>
      <Button type="submit" disabled={!routine.days.length || !routine.placeId || !routine.requester.id}>{existing ? copy.save : copy.routineAdd}</Button>
      {existing && <><Button variant="secondary" onClick={() => { if (routine.enabled) setConfirm('disable'); else void save(true); }}>{routine.enabled ? copy.routineDisable : copy.routineOn}</Button><Button variant="plain" onClick={() => setConfirm('delete')}>{copy.routineDelete}</Button></>}
    </form>
  </div>{confirm && <Sheet title={confirm === 'disable' ? copy.routineDisableDesc : copy.routineDeleteDesc} close={() => setConfirm(null)}><div className="stack">
    <Button onClick={() => { void save(false, true, confirm === 'delete'); }}>{confirm === 'disable' ? copy.routineDisableTogether : copy.routineDelete}</Button>
    <Button variant="secondary" onClick={() => { if (confirm === 'disable') void save(false); else setConfirm(null); }}>{confirm === 'disable' ? copy.routineKeep : copy.back}</Button>
  </div></Sheet>}</>;
}

function MemberDetail({ state, member, id }: Props & { id: string }) {
  const person = state.members.find((item) => item.id === id);
  const commit = useCommit();
  const allowed = member.id === id || member.id === state.members[0].id;
  function patch(fields: Partial<Person>) {
    void commit((current) => {
      const members = current.members.map((item) => item.id === id ? { ...item, ...fields } : item);
      const vehicle = fields.canDrive === false && current.vehicle.currentDriverId === id ? { ...current.vehicle, currentDriverId: members.find((item) => item.canDrive)?.id ?? null } : current.vehicle;
      return changed({ ...current, members, vehicle });
    });
  }
  if (!person) return <Navigate to="/p/family" replace />;
  const busy = state.pickups.some((pickup) => pickup.assigneeId === person.id && isActivePickup(pickup));
  return <><MobileHeader title={person.name} back="/p/family" /><div className="mobile-content stack">
    <label className="checkbox"><input type="checkbox" checked={person.canRequest} disabled={!allowed} onChange={(event) => patch({ canRequest: event.target.checked })} />{copy.canRequest}</label>
    <label className="checkbox"><input type="checkbox" checked={person.canDrive} disabled={!allowed || busy} onChange={(event) => patch({ canDrive: event.target.checked })} />{copy.canDrive}</label>
  </div></>;
}

function RiderDetail({ state, id }: Props & { id: string }) {
  const person = state.riders.find((item) => item.id === id);
  const [name, setName] = useState(person?.name ?? '');
  const [phone, setPhone] = useState(person?.phone ?? '');
  const [kind, setKind] = useState<'child' | 'adult'>('child');
  const [consent, setConsent] = useState(false);
  const commit = useCommit();
  const navigate = useNavigate();
  const now = useClock(state);
  const [disconnect, setDisconnect] = useState(false);
  const [showCode, setShowCode] = useState(!person?.connected);
  if (id === 'new') return <><MobileHeader className="guardian-back-header" back="/p/family" /><div className="mobile-content guardian-flow">
    <h1>{copy.addRider}</h1><form className="stack guardian-form-grow" onSubmit={async (event) => {
      event.preventDefault();
      const rider = { id: uid(), familyId, name: name.trim(), phone: phone.trim() || undefined, kind, connected: false };
      await commit((current) => changed({ ...current, riders: [...current.riders, rider] }));
      navigate(`/p/riders/${rider.id}`);
    }}>
      <label className="field">{copy.name}<input value={name} required maxLength={20} onChange={(event) => setName(event.target.value)} placeholder={copy.namePlaceholder} /></label>
      <label className="field">{copy.phone}<input type="tel" value={phone} maxLength={22} onChange={(event) => setPhone(event.target.value)} placeholder={copy.phoneFormat} /></label>
      <div className="chips"><button type="button" className="chip" aria-pressed={kind === 'child'} onClick={() => setKind('child')}>{copy.child}</button><button type="button" className="chip" aria-pressed={kind === 'adult'} onClick={() => setKind('adult')}>{copy.adult}</button></div>
      {kind === 'child' ? <label className="checkbox"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />{copy.consentGuardian}</label> : <p className="small muted">{copy.consentAdultLater}</p>}
      <div className="guardian-flow-actions stack"><Button type="submit" disabled={!name.trim() || kind === 'child' && !consent}>{copy.riderAdd}</Button></div>
    </form>
  </div></>;
  if (!person) return <Navigate to="/p/family" replace />;
  const invite = state.invite.riderId === person.id && !state.invite.used && state.invite.expiresAt > now ? state.invite : null;
  const invitePath = invite ? `/c/start?code=${invite.code}` : '';
  const generate = () => {
    setShowCode(true);
    void commit((current, stamp) => {
      const code = String(10_000_000 + crypto.getRandomValues(new Uint32Array(1))[0] % 90_000_000);
      return changed({ ...current, invite: { code, riderId: person.id, expiresAt: stamp + 10 * minute, used: false } });
    });
  };
  return <><MobileHeader title={person.name} back="/p/family" className="guardian-detail-header" /><div className="mobile-content stack guardian-rider-management">
    {showCode ? <>
      <h2>{copy.simpleLink}</h2>
      {invite && <><InviteQr href={new URL(invitePath, window.location.origin).href} demo /><h3 className="guardian-scan-title">{copy.scanRiderQr}</h3><div className="guardian-invite-number guardian-rider-code"><p>{copy.enterInApp}</p><output>{invite.code.slice(0, 4)} {invite.code.slice(4)}</output><span><Clock3 size={18} />{copy.codeRemaining(Math.ceil((invite.expiresAt - now) / minute))}</span></div><a className="button button--outline" href={invitePath}>{copy.installHelp}</a></>}
      <Button variant={invite ? 'plain' : 'primary'} onClick={generate}>{copy.newCode}</Button>
      {person.connected && <Button variant="plain" onClick={() => setShowCode(false)}>{copy.back}</Button>}
    </> : <>
      <p className="guardian-connected-banner"><Check size={18} />{copy.connectedPhone}</p>
      <section><h3>{copy.connectedPhone}</h3><Row icon={<Smartphone size={19} />} title={copy.simpleLink} caption={person.phone || copy.demoLabel} trailing={<Button variant="outline" onClick={() => setDisconnect(true)}>{copy.disconnect}</Button>} /></section>
      <section><h3>{copy.routine}</h3>{state.routines.filter((routine) => routine.requester.id === person.id).map((routine) => <Row key={routine.id} icon={<CalendarDays size={19} />} title={`${routine.days.map((day) => copy.weekdays[day]).join(' ')} ${routine.time}`} caption={state.places.find((place) => place.id === routine.placeId)?.label} to={`/p/routines/${routine.id}`} />)}</section>
      <Button variant="outline" onClick={() => invite ? setShowCode(true) : generate()}><QrCode size={19} />{copy.simpleLink}</Button>
    </>}
  </div>{disconnect && <Sheet title={copy.riderDisconnectQuestion} close={() => setDisconnect(false)}><div className="stack">
    <Button variant="danger" onClick={async () => { await commit((current) => changed({ ...current, riders: current.riders.map((item) => item.id === person.id ? { ...item, connected: false } : item) })); setDisconnect(false); }}>{copy.disconnect}</Button>
    <Button variant="secondary" onClick={() => setDisconnect(false)}>{copy.back}</Button>
  </div></Sheet>}</>;
}

function PlaceEditor({ state, id }: Props & { id: string }) {
  const existing = state.places.find((place) => place.id === id);
  const routeState = useLocation().state as { coords?: { lat: number; lng: number }; fromPickup?: string } | null;
  const [label, setLabel] = useState(existing?.label ?? '');
  const [kind, setKind] = useState<string>(existing?.kind ?? copy.placeKinds[3]);
  const [radius, setRadius] = useState(existing?.radiusM ?? 150);
  const [coords, setCoords] = useState(existing ?? (routeState?.coords && isCoordinates(routeState.coords) ? routeState.coords : pinOrigin));
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(Boolean(existing || routeState?.coords));
  const [archive, setArchive] = useState(false);
  const [point, setPoint] = useState(false);
  const navigate = useNavigate();
  const commit = useCommit();
  const toast = useToast();
  if (id !== 'new' && !existing) return <Navigate to="/p/family" replace />;
  const back = routeState?.fromPickup && /^[\w-]+$/.test(routeState.fromPickup) ? `/p/pickups/${routeState.fromPickup}/location` : '/p/family';
  if (!editing) {
    const results = query.trim() ? state.places.filter((place) => !place.archivedAt && place.label.includes(query.trim())) : [];
    return <><MobileHeader back={back} className="guardian-back-header" /><div className="mobile-content guardian-flow guardian-place-search">
      <h1>{copy.placeAdd}</h1><label className="field guardian-search"><Search size={19} /><input type="search" aria-label={copy.mapSearch} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={copy.mapSearch} /></label>
      <p className="small muted">{copy.demoPlacesHint}</p>
      {query.trim() && !results.length && <p className="muted">{copy.noSearch}</p>}
      {results.map((result) => <Row key={result.id} icon={<MapPin size={18} />} title={result.label} caption={result.kind} to={`/p/places/${result.id}`} />)}
      <Row icon={<Map size={21} />} title={copy.mapChooseManually} onClick={() => { setLabel(query.trim()); setEditing(true); }} />
    </div></>;
  }
  return <><MobileHeader back={back} className="guardian-back-header" /><div className="mobile-content stack guardian-place-editor">
    <h1>{existing ? copy.placeEdit : copy.placeAdd}</h1>
    <form className="stack" onSubmit={async (event) => {
      event.preventDefault();
      const place = { id: existing?.id ?? uid(), familyId, label: label.trim(), kind, radiusM: radius, lat: coords.lat, lng: coords.lng };
      await commit((current) => changed({ ...current, places: existing ? current.places.map((item) => item.id === id ? place : item) : [...current.places, place] }));
      navigate(routeState?.fromPickup && /^[\w-]+$/.test(routeState.fromPickup) ? `/p/pickups/${routeState.fromPickup}/location` : '/p/family');
    }}>
      <MapPreview coords={coords} onMove={setCoords} uncertain /><label className="field">{copy.name}<input required maxLength={30} value={label} onChange={(event) => setLabel(event.target.value)} /></label>
      <fieldset><legend>{copy.kind}</legend><div className="chips">{copy.placeKinds.map((item) => <button type="button" className="chip" aria-pressed={item === kind} key={item} onClick={() => setKind(item)}>{item}</button>)}</div></fieldset>
      <fieldset><legend>{copy.radius}</legend><div className="guardian-radius">{[[100, copy.narrow], [150, copy.normal], [300, copy.wide]].map(([metres, title]) => <button key={metres} type="button" aria-pressed={radius === metres} onClick={() => setRadius(Number(metres))}><strong>{title}</strong><span>{metres}m</span></button>)}</div></fieldset>
      <Button type="submit" disabled={!label.trim()}>{copy.save}</Button>
    </form>
    {existing && <section className="stack"><h2>{copy.pickupPoint}</h2>{state.points.filter((item) => item.placeId === id && item.archivedAt == null).map((item) => <Row key={item.id} title={item.label} caption={item.note} trailing={<Button variant="plain" onClick={() => { void commit((current, now) => changed({ ...current, points: current.points.map((entry) => entry.id === item.id ? { ...entry, archivedAt: now } : entry) })); }}>{copy.pointRemove}</Button>} />)}
      <Button variant="outline" onClick={() => setPoint(true)}>{copy.pointAdd}</Button><Button variant="plain" onClick={() => { if (state.routines.some((item) => item.placeId === id)) toast(copy.placeInUse); else setArchive(true); }}>{copy.placeArchive}</Button>
    </section>}
  </div>{point && existing && <NewPoint place={existing} close={() => setPoint(false)} />}
    {archive && <Sheet title={copy.placeArchiveQuestion} close={() => setArchive(false)}><div className="stack"><Button variant="danger" onClick={async () => { await commit((current, now) => changed({ ...current, places: current.places.map((item) => item.id === id ? { ...item, archivedAt: now } : item) })); navigate('/p/family'); }}>{copy.placeArchive}</Button><Button variant="secondary" onClick={() => setArchive(false)}>{copy.back}</Button></div></Sheet>}
  </>;
}

function NewPoint({ place, close }: { place: DemoState['places'][number]; close: () => void }) {
  const [coords, setCoords] = useState({ lat: place.lat, lng: place.lng });
  const [label, setLabel] = useState('');
  const [note, setNote] = useState('');
  const commit = useCommit();
  return <Sheet title={copy.pointAdd} close={close}><form className="stack" onSubmit={async (event) => {
    event.preventDefault();
    const result = await commit((current) => {
      if (current.points.some((item) => item.placeId === place.id && item.archivedAt == null && item.label === label.trim())) return { ok: false, state: current, code: 'VALIDATION' };
      return changed({ ...current, points: [...current.points, { ...coords, id: uid(), familyId, placeId: place.id, label: label.trim(), note: note.trim() || undefined }] });
    });
    if (result.ok) close();
  }}><MapPreview coords={coords} onMove={setCoords} /><label className="field">{copy.name}<input required value={label} maxLength={20} onChange={(event) => setLabel(event.target.value)} /></label>
    <label className="field">{copy.mapNote}<input value={note} maxLength={40} onChange={(event) => setNote(event.target.value)} /></label><Button type="submit" disabled={!label.trim()}>{copy.save}</Button><Button variant="plain" onClick={close}>{copy.back}</Button>
  </form></Sheet>;
}

function VehicleDetail({ state }: Props) {
  const commit = useCommit();
  const [confirmed, setConfirmed] = useState(false);
  const now = useClock(state);
  const assigned = state.pickups.filter((pickup) => pickup.vehicleId === state.vehicle.id && isActivePickup(pickup));
  const estimate = rangeEstimate(state, assigned, state.vehicle);
  const currentRange = state.vehicle.range;
  return <><MobileHeader back="/p/family" className="guardian-back-header" /><div className="mobile-content stack guardian-vehicle-page">
    <div className="guardian-section-heading"><h1>{state.vehicle.name}</h1><Badge tone="neutral">{copy.demoValue}</Badge></div>
    <section><h2>{copy.rangeTitle}</h2><p className="range-number">{currentRange == null ? copy.noRange : `${currentRange}km`}</p>
      {state.vehicle.rangeCollectedAt && <p className="small muted">{copy.collectionTime} {clock(state.vehicle.rangeCollectedAt)}</p>}</section>
    <section><h2>{copy.currentDriver}</h2><div className="chips">{state.members.filter((person) => person.canDrive).map((person) => <button type="button" className="chip" key={person.id} aria-pressed={state.vehicle.currentDriverId === person.id} disabled={Boolean(state.vehicle.activePickupId)} onClick={() => { void commit((current) => current.vehicle.activePickupId ? { ok: false, state: current, code: 'VEHICLE_BUSY' } : changed({ ...current, vehicle: { ...current.vehicle, currentDriverId: person.id } })); }}>{person.name}</button>)}</div></section>
    <section><h2>{copy.todaySchedule}</h2>
      {assigned.filter((pickup) => dateLabel(pickup.wantedAt) === dateLabel(now)).map((pickup) => <Row key={pickup.id} icon={<time>{clock(pickup.wantedAt)}</time>} title={`${nameOf(state, pickup.requester.id)}, ${pickup.destination.label}`} to={`/p/pickups/${pickup.id}`} />)}
      {demoRoutinesToday(state, now).filter((routine) => routine.vehicleId === state.vehicle.id).map((routine) => <Row key={routine.id} icon={<time>{routine.time}</time>} title={`${nameOf(state, routine.requester.id)}, ${state.places.find((place) => place.id === routine.placeId)?.label ?? copy.location}`} to={`/p/routines/${routine.id}`} />)}
    </section>
    {!confirmed && estimate.verdict === 'low' && estimate.requiredKm != null && currentRange != null && <div className="guardian-range-warning stack"><h3><CircleAlert size={21} />{copy.rangeInsufficient}</h3><p>{copy.rangeNeed(estimate.requiredKm)}, {copy.rangeCurrent(currentRange)}</p><Button onClick={() => setConfirmed(true)}>{copy.confirm}</Button></div>}
    <a href="/v/" className="button button--outline">{copy.carDemoTitle}</a>
  </div></>;
}

function DemoVehiclePair({ state }: Props) {
  const navigate = useNavigate();
  const commit = useCommit();
  const [params] = useSearchParams();
  const code = (params.get('code') ?? copy.pairDemoCode).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  const [driver, setDriver] = useState(state.vehicle.currentDriverId ?? '');
  const [name, setName] = useState(state.vehicle.name);
  return <><MobileHeader back="/p/family" className="guardian-back-header" /><div className="mobile-content guardian-flow guardian-vehicle-pair">
    <h1>{copy.vehiclesPairTitle}</h1><p className="muted">{copy.vehiclesPairDescription}</p>
    <form className="stack guardian-form-grow" onSubmit={async (event) => {
      event.preventDefault();
      const result = await commit((current) => current.vehicle.activePickupId ? { ok: false, state: current, code: 'VEHICLE_BUSY' } : changed({ ...current, vehicle: { ...current.vehicle, name: name.trim(), currentDriverId: driver } }), copy.pairDemoDone);
      if (result.ok) navigate(`/p/vehicles/${state.vehicle.id}`);
    }}>
      <output className="guardian-vehicle-code">{code.slice(0, 3)}-{code.slice(3)}</output>
      <label className="field">{copy.carNickname}<input maxLength={20} value={name} required onChange={(event) => setName(event.target.value)} /></label>
      <fieldset><legend>{copy.currentDriver}</legend><div className="chips">{state.members.filter((person) => person.canDrive).map((person) => <button type="button" className="chip" key={person.id} aria-pressed={driver === person.id} onClick={() => setDriver(person.id)}>{person.name}</button>)}</div></fieldset>
      <div className="stack guardian-flow-actions"><Button type="submit" disabled={code.length !== 6 || !driver || !name.trim()}>{copy.connect}</Button><p className="small muted guardian-demo-note">{copy.carPairDemoHint}</p></div>
    </form>
  </div></>;
}
