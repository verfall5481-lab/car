import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowRight, CalendarDays, Check, CircleAlert, Clock3, EllipsisVertical, Grid2X2, Info, MapPin, Phone, PlusSquare, Share, Smartphone, TriangleAlert } from 'lucide-react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { isActivePickup, resolveDestination } from '@deriro/contracts';
import type { Coordinates, LocationInput, Pickup, Requester } from '@deriro/contracts';
import { clock, copy } from './copy.ts';
import { changed, destinationLabel, exampleGps, nameOf } from './demo-domain.ts';
import type { DemoState } from './demo-domain.ts';
import { Button, CodeInput, MapPreview, MobileHeader, pinOrigin, Row, Sheet, Status, StepCheck, useClock, useCommit, usePickupAction, usePickupOperations, usePickupRequest, useToast } from './ui.tsx';
import { browserPosition, locationPermission, reverseAddress, useMapKey } from './live/maps.tsx';
import { RpcError } from './live/errors.ts';
import './rider.css';

export function PinPicker({ choose, close, initial, position }: { choose: (location: Extract<LocationInput, { source: 'map_pin' }>) => void; close: () => void; initial?: Coordinates; position?: Coordinates }) {
  const live = Boolean(usePickupOperations()?.live);
  const key = useMapKey();
  const [coords, setCoords] = useState(initial ?? (live && key ? { lat: 36.45, lng: 127.9 } : live ? undefined : pinOrigin));
  const [latitude, setLatitude] = useState(coords ? String(coords.lat) : '');
  const [longitude, setLongitude] = useState(coords ? String(coords.lng) : '');
  const [address, setAddress] = useState('');
  const [note, setNote] = useState('');
  const valid = coords && coords.lat >= 33 && coords.lat <= 39 && coords.lng >= 124 && coords.lng <= 132;
  useEffect(() => {
    if (!key || !coords) return;
    let current = true;
    const timer = window.setTimeout(() => { void reverseAddress(key, coords).then((value) => { if (current) setAddress(value ?? ''); }).catch(() => {}); }, 350);
    return () => { current = false; window.clearTimeout(timer); };
  }, [coords, key]);
  function move(next: Coordinates) { setCoords(next); setLatitude(String(next.lat)); setLongitude(String(next.lng)); }
  function enter(lat: string, lng: string) {
    setLatitude(lat); setLongitude(lng);
    setCoords(lat.trim() && lng.trim() && Number.isFinite(Number(lat)) && Number.isFinite(Number(lng)) ? { lat: Number(lat), lng: Number(lng) } : undefined);
  }
  return <Sheet title={copy.mapPick} close={close} className="rider-map-sheet">
    <MapPreview coords={coords} onMove={move} />
    <p className="small muted">{live && !key ? copy.mapUnavailableHint : copy.mapInstructions}</p>
    {live && <div className="coordinate-inputs"><label className="field">{copy.coordinateLatitude}<input inputMode="decimal" value={latitude} onChange={(event) => enter(event.target.value, longitude)} /></label><label className="field">{copy.coordinateLongitude}<input inputMode="decimal" value={longitude} onChange={(event) => enter(latitude, event.target.value)} /></label></div>}
    <p className="place-meta"><MapPin size={18} />{live ? address || copy.placeGeneric : copy.mapArea}</p>
    <div className="chips">{copy.mapNoteOptions.map((item) => <button type="button" className="chip" aria-pressed={note === item} onClick={() => setNote(item)} key={item}>{item}</button>)}</div>
    <label className="field">{copy.mapNote}<input maxLength={20} value={note} onChange={(event) => setNote(event.target.value)} placeholder={copy.mapPlaceholder} /></label>
    <Button disabled={!valid} onClick={() => { if (valid && coords) choose({ source: 'map_pin', ...coords, label: live ? address.slice(0, 40) || copy.placeGeneric : copy.mapArea, note: note.trim() || undefined, currentLocation: position }); }}>{copy.pickHere}</Button>
    <Button variant="plain" onClick={close}>{copy.back}</Button>
  </Sheet>;
}

function CallBar({ state, requester, emphasized = false }: { state: DemoState; requester: Requester; emphasized?: boolean }) {
  const toast = useToast();
  const members = state.members.filter((member) => member.canDrive && member.leftAt == null && member.id !== requester.id && (!state.live || (member.phone && /^\+[1-9]\d{6,14}$/.test(member.phone))));
  if (!members.length) return null;
  return <div className={`call-bar${emphasized ? ' call-bar--emphasized' : ''}`}>{members.map((member) => state.live ?
    <a key={member.id} href={`tel:${member.phone}`}><Phone size={17} />{copy.call(member.name)}</a> :
    <button type="button" key={member.id} onClick={() => toast(copy.callDemo)}><Phone size={17} />{copy.call(member.name)}</button>)}</div>;
}

function Steps({ pickup, state }: { pickup: Pickup; state: DemoState }) {
  const labels = [copy.sentStep, nameOf(state, pickup.assigneeId) || copy.assignee, copy.statuses.en_route, copy.statuses.arrived, copy.boardedStep];
  const index = ['open', 'assigned', 'en_route', 'arrived', 'completed'].indexOf(pickup.status);
  return <ol className="rider-steps">{labels.map((label, i) => <li key={i} className={i <= index ? 'is-done' : undefined} aria-current={i === index ? 'step' : undefined}><StepCheck done={i <= index} /><span>{label}</span></li>)}</ol>;
}

export function RiderRequest({ state, requester, back }: { state: DemoState; requester: Requester; back?: string }) {
  const request = usePickupRequest();
  const operations = usePickupOperations();
  const act = usePickupAction();
  const toast = useToast();
  const now = useClock(state);
  const [placeId, setPlaceId] = useState('');
  const [pointId, setPointId] = useState('');
  const [gps, setGps] = useState<Extract<LocationInput, { source: 'gps' }> | null>(null);
  const [gpsBusy, setGpsBusy] = useState(false);
  const [geoDenied, setGeoDenied] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [different, setDifferent] = useState(false);
  const userChoseLocation = useRef(false);
  const [mapPin, setMapPin] = useState<Extract<LocationInput, { source: 'map_pin' }> | null>(null);
  const [placeMode, setPlaceMode] = useState<'saved' | 'map' | 'gps'>('saved');
  const [delay, setDelay] = useState(0);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [open, setOpen] = useState<'map' | 'cancel' | 'geo' | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const places = state.places.filter((place) => place.archivedAt == null);
  const points = state.points.filter((point) => point.placeId === placeId && point.archivedAt == null);
  const name = nameOf(state, requester.id);
  const ownPickups = state.pickups.filter((pickup) => pickup.requester.kind === requester.kind && pickup.requester.id === requester.id);
  const priority: Record<Pickup['status'], number> = { arrived: 0, en_route: 1, assigned: 2, open: 3, completed: 4, cancelled: 4, expired: 4, closed_unconfirmed: 4 };
  const scheduled = (pickup: Pickup) => pickup.source === 'routine' && pickup.readyAt == null && (pickup.status === 'open' || pickup.status === 'assigned');
  const active = ownPickups.filter(isActivePickup).sort((a, b) => Number(scheduled(a)) - Number(scheduled(b)) || priority[a.status] - priority[b.status] || a.wantedAt - b.wantedAt);
  const latest = ownPickups.filter((item) => !isActivePickup(item)).map((item) => ({ item, at: state.terminalAt?.[item.id] ?? state.history.find((event) => event.pickupId === item.id && ['completed', 'cancelled', 'expired', 'closed_unconfirmed'].includes(event.event))?.at ?? 0 }))
    .filter(({ item, at }) => now - at < (item.status === 'closed_unconfirmed' ? 600_000 : 60_000)).sort((a, b) => b.at - a.at)[0]?.item;
  const current = active.find((item) => !different || item.source === 'request') ?? (!different && latest?.id !== dismissed ? latest : undefined);
  const secondary = active.filter((item) => item.id !== current?.id);
  const regular = current?.source === 'routine' && current.readyAt == null && (current.status === 'open' || current.status === 'assigned');
  const assignee = current ? nameOf(state, current.assigneeId) : '';
  const capabilities = current ? state.pickupCapabilities?.[current.id] : undefined;
  const requestedAt = current && state.history.find((event) => event.event === 'requested' && event.pickupId === current.id)?.at;
  const escalated = current?.status === 'open' && ((capabilities?.escalation ?? 0) > 0 || requestedAt != null && now >= requestedAt + 300_000);
  let location: LocationInput | null = null;
  if (placeMode === 'map') location = mapPin;
  else if (placeMode === 'gps') location = state.live ? gps : exampleGps;
  else if (points.some(({ id }) => id === pointId)) location = { source: 'saved_point', pickupPointId: pointId };
  else if (places.some(({ id }) => id === placeId) && !points.length) location = { source: 'saved_place', placeId };

  useEffect(() => {
    if (countdown == null || countdown <= 0) return;
    const timer = window.setTimeout(() => setCountdown(countdown - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [countdown]);
  const [pending, setPending] = useState<{ requester: Requester; location: LocationInput; delay: number } | null>(null);
  useEffect(() => {
    function cancelWhileHidden() { if (document.hidden) { setPending(null); setCountdown(null); } }
    document.addEventListener('visibilitychange', cancelWhileHidden);
    return () => document.removeEventListener('visibilitychange', cancelWhileHidden);
  }, []);
  useEffect(() => {
    if (countdown !== 0 || !pending || document.hidden) return;
    setPending(null);
    setCountdown(null);
    setSubmitting(true);
    void request(pending.requester, pending.location, pending.delay).then((ok) => { if (ok) setDifferent(false); }).finally(() => setSubmitting(false));
  }, [countdown, pending, request]);
  useEffect(() => {
    if (!state.live) return;
    let mounted = true;
    void locationPermission().then((permission) => {
      if (permission === 'denied' && mounted) setGeoDenied(true);
      if (permission === 'granted') void browserPosition().then((value) => {
        if (!mounted) return;
        setGps(value);
        if (!userChoseLocation.current) setPlaceMode('gps');
      }).catch(() => {});
    });
    return () => { mounted = false; };
  }, [state.live]);

  async function useHere() {
    userChoseLocation.current = true;
    if (!state.live) { setPlaceMode('gps'); return; }
    setGpsBusy(true);
    try {
      const value = await browserPosition();
      setGps(value); setPlaceMode('gps');
    } catch (error) {
      const denied = error instanceof RpcError && error.code === 'GEO_DENIED';
      if (denied) setGeoDenied(true);
      toast(denied ? copy.geoDenied : copy.geoUnavailable);
    } finally { setGpsBusy(false); }
  }

  function selectPlace(id: string) {
    userChoseLocation.current = true;
    setPlaceId(id);
    const choices = state.points.filter((point) => point.placeId === id && point.archivedAt == null);
    setPointId(choices.length === 1 ? choices[0].id : '');
    setPlaceMode('saved');
  }

  const headline = current ? {
    open: escalated ? copy.riderWaitEscalated : copy.requestSent,
    assigned: copy.acceptRider(assignee), en_route: copy.departedRider(assignee), arrived: copy.arrivedRider(assignee),
    completed: copy.boardedRider, cancelled: copy.requestCancelled, expired: copy.requestExpired, closed_unconfirmed: copy.closedUnconfirmed,
  }[current.status] : '';
  const cancelable = current && isActivePickup(current) && current.source === 'request' && current.status !== 'arrived' && capabilities?.cancel !== false;
  const gpsConfirmed = gps ? resolveDestination(places[0]?.familyId ?? '', gps, places)?.confirmed : false;
  const gpsSelected = placeMode === 'gps';
  const destination = current ? destinationLabel(state, current.destination) : '';
  const notMetRecent = current?.notMetAt != null && now < current.notMetAt + 300_000;
  const callEmphasized = escalated || notMetRecent || current?.status === 'expired' || current?.status === 'closed_unconfirmed';
  const countdownPlace = pending && (pending.location.source === 'map_pin' ? pending.location.label :
    pending.location.source === 'gps' ? copy.currentPlace : points.find((point) => point.id === pointId)?.label ?? places.find((place) => place.id === placeId)?.label);

  return <>
    <MobileHeader title={name} back={back} className="mobile-header--rider">{!back && <Link to="/c/me" className="icon-button" aria-label={copy.info}><Info size={22} /></Link>}</MobileHeader>
    <div className="rider-content">
      {current && regular ? <section className="rider-routine" aria-live="polite">
        <div className="rider-routine-card">
          <span className="place-meta"><CalendarDays size={17} />{copy.today}</span>
          <h2>{copy.routineWaiting(clock(current.wantedAt), destination)}</h2>
          <Button variant="amber" disabled={operations?.pending || capabilities?.ready === false} onClick={() => { void act(current, requester, { type: 'ready', expectedVersion: current.version }, copy.earlySent); }}>{copy.routineEarly}</Button>
        </div>
        <Button variant="plain" onClick={() => setDifferent(true)}>{copy.differentPlace}</Button>
      </section> : current ? <section className="rider-progress" aria-live="polite">
        {current.status === 'completed' && <span className="success-circle"><Check size={38} /></span>}
        {callEmphasized && current.status !== 'arrived' && <CircleAlert className="rider-status-icon" size={38} />}
        <h2>{headline}</h2>
        {current.status === 'completed' && <p>{copy.boardedDesc}</p>}
        {current.status === 'open' && <p>{escalated ? copy.callEscalated : copy.requestWaiting}</p>}
        {isActivePickup(current) && <p className="rider-destination"><MapPin size={18} />{current.status === 'en_route' ? copy.whereWaiting(destination) : destination}{current.status === 'open' && <span>{current.wantedAt <= now ? copy.dateNow : clock(current.wantedAt)}</span>}</p>}
        {['open', 'assigned', 'en_route', 'arrived', 'completed'].includes(current.status) && <Steps pickup={current} state={state} />}
        {current.status === 'arrived' && <div className="stack">
          <Button variant="amber" disabled={operations?.pending} onClick={() => { void act(current, requester, { type: 'board', expectedVersion: current.version }); }}>{copy.boardRider}</Button>
          <Button variant="plain" disabled={operations?.pending || (capabilities?.notMet ?? !notMetRecent) === false} onClick={() => { void act(current, requester, { type: 'not_met', expectedVersion: current.version }, copy.notMetSent); }}>{notMetRecent ? copy.notMetSent : copy.notMetRider}</Button>
        </div>}
        {!isActivePickup(current) && <Button variant="secondary" onClick={() => setDismissed(current.id)}>{current.status === 'completed' ? copy.done : copy.requestAgain}</Button>}
      </section> : countdown != null ? <section className="rider-countdown">
        <div className="rider-countdown-face">
          <svg viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="55" /><circle className="countdown-ring" cx="60" cy="60" r="55" pathLength="100" strokeDasharray={`${Math.max(1, countdown) * 100 / 3} 100`} /></svg>
          <div><strong aria-live="polite">{countdown || 1}</strong><span>{copy.requestCountdown}</span></div>
        </div>
        <p>{countdownPlace} · {delay ? copy.minutesLater(delay) : copy.dateNow}</p>
        <Button variant="secondary" onClick={() => { setCountdown(null); setPending(null); }}>{copy.cancelCountdown}</Button>
      </section> : <section className="rider-form">
        <fieldset><legend>{copy.where}</legend>
          {gpsSelected && <p className="rider-here"><span className="badge-dot" aria-hidden="true" />{gpsConfirmed ? copy.currentPlace : copy.approxHere}{!state.live && <small>{copy.demoValue}</small>}</p>}
          <div className="chips chips--places">
            {places.map((place) => <button type="button" key={place.id} className="chip" aria-pressed={placeMode === 'saved' && place.id === placeId} onClick={() => selectPlace(place.id)}>{place.label}</button>)}
          </div>
          {placeMode === 'saved' && points.length > 0 && <div className="point-picker"><span>{copy.pickupPoint}</span><div className="chips">{points.map((point) => <button type="button" key={point.id} className="chip chip--small" aria-pressed={pointId === point.id} onClick={() => setPointId(point.id)}>{point.label}</button>)}</div></div>}
          <div className="rider-location-actions">
            {!geoDenied && !gpsSelected && <button className="rider-location-link" type="button" disabled={gpsBusy} title={state.live ? undefined : copy.gpsNote} onClick={() => { if (state.live && !gps) setOpen('geo'); else void useHere(); }}><MapPin size={15} />{state.live ? copy.useGeo : copy.currentPlace}{!state.live && <small>{copy.demoValue}</small>}</button>}
            <button type="button" className="rider-location-link" aria-pressed={placeMode === 'map'} onClick={() => setOpen('map')}><MapPin size={15} />{placeMode === 'map' && mapPin ? [mapPin.label, mapPin.note].filter(Boolean).join(', ') : copy.onMap}</button>
          </div>
        </fieldset>
        <fieldset><legend>{copy.when}</legend><div className="chips time-chips">{[0, 10, 20, 30].map((item) => <button type="button" key={item} className="chip" aria-pressed={delay === item} onClick={() => setDelay(item)}>{item ? copy.minutesLater(item) : copy.dateNow}</button>)}</div></fieldset>
        <div className="rider-cta">
          <button type="button" className="request-button" disabled={!location || submitting || operations?.pending} onClick={() => { if (location) { setPending({ requester, location, delay }); setCountdown(3); } }}>
            {submitting ? copy.loading : location ? copy.request : placeMode === 'saved' && placeId && points.length ? copy.selectPoint : copy.selectFirst}
          </button>
        </div>
      </section>}
      {secondary.length > 0 && <section className="secondary-pickups" aria-label={copy.secondPickup}>{secondary.map((pickup) => <div key={pickup.id}><Status pickup={pickup} /><p>{clock(pickup.wantedAt)}, {destinationLabel(state, pickup.destination)}</p></div>)}</section>}
      <CallBar state={state} requester={requester} emphasized={callEmphasized} />
      {cancelable && !regular && <Button variant="plain" className="rider-cancel" onClick={() => setOpen('cancel')}>{copy.cancelRequest}</Button>}
    </div>
    {open === 'map' && <PinPicker initial={mapPin ?? places.find((place) => place.id === placeId) ?? gps ?? undefined} position={gps ?? undefined} close={() => setOpen(null)} choose={(location) => { userChoseLocation.current = true; setMapPin(location); setPlaceMode('map'); setOpen(null); }} />}
    {open === 'geo' && <Sheet title={copy.useGeo} close={() => setOpen(null)} className="rider-prompt-sheet"><div className="stack"><p>{copy.locationAtRequest}</p><RiderLocationIllustration /><Button variant="amber" onClick={() => { setOpen(null); void useHere(); }}>{copy.allowLocation}</Button><Button variant="plain" onClick={() => setOpen(null)}>{copy.riderLocationLater}</Button></div></Sheet>}
    {open === 'cancel' && current && <Sheet title={current.status === 'en_route' ? copy.cancelWhileComing(assignee) : copy.cancelQuestion} close={() => setOpen(null)} className="rider-prompt-sheet">
      <div className="stack"><Button variant="danger" onClick={async () => { await act(current, requester, { type: 'cancel', expectedVersion: current.version }); setOpen(null); }}>{copy.cancelYes}</Button>
        <Button variant="secondary" onClick={() => setOpen(null)}>{copy.cancelNo}</Button></div>
    </Sheet>}
  </>;
}

export function RiderInfo({ state, riderId }: { state: DemoState; riderId: string }) {
  return <><MobileHeader title={copy.info} back="/c/" className="mobile-header--rider" /><div className="mobile-content stack rider-info">
    <h2>{nameOf(state, riderId)}</h2><p className="muted">{copy.locationOnce} {copy.demoLocationOnly}</p>
    <Row icon={<Smartphone size={19} />} title={copy.simpleLink} to="/c/link" />
    <Row icon={<PlusSquare size={19} />} title={copy.installHelp} to="/c/install" />
  </div></>;
}

export function RiderLocationIllustration() {
  return <span className="location-illustration" aria-hidden="true"><MapPin size={58} strokeWidth={1.45} /></span>;
}

export function RiderInstallSteps() {
  if (/Android/i.test(navigator.userAgent)) return <ol className="rider-install-android">
    <li><span><EllipsisVertical size={24} /></span>{copy.installMenu}<ArrowRight className="install-next" size={22} aria-hidden="true" /></li>
    <li><span><PlusSquare size={24} /></span>{copy.addHome}</li>
  </ol>;
  const steps = [[Share, copy.shareButton], [PlusSquare, copy.addHome], [Grid2X2, copy.openHome]] as const;
  return <ol className="rider-install-steps">{steps.map(([Icon, label], index) => <li key={label}>
    <span><Icon size={23} /></span><strong>{label}</strong>{index < steps.length - 1 && <ArrowDown size={15} className="install-arrow" />}
  </li>)}</ol>;
}

export function RiderInstallCode({ code, privacy = false }: { code: string; privacy?: boolean }) {
  return <div className="code-box rider-install-code"><strong>{copy.enterInApp}</strong><output>{code.slice(0, 4)} {code.slice(4)}</output><p className="muted">{copy.codeLimit}</p>{privacy && <p className="small">{copy.startLinkPrivacy}</p>}</div>;
}

export function RiderPairHeading({ error, retrySeconds = 0 }: { error: string; retrySeconds?: number }) {
  const retrying = retrySeconds > 0;
  const expired = error === copy.codeExpired;
  const used = error === copy.codeUsed;
  const ErrorIcon = used ? TriangleAlert : expired || retrying ? Clock3 : null;
  return <div className="rider-pair-heading" aria-live="polite">
    {ErrorIcon && <ErrorIcon size={48} strokeWidth={1.8} className={retrying ? undefined : 'rider-status-icon'} aria-hidden="true" />}
    <h2>{expired ? copy.riderCodeExpiredTitle : used ? copy.riderCodeUsedTitle : retrying ? copy.riderCodeRetryTitle : copy.codeTitle}</h2>
    {(expired || used) && <p className="muted">{copy.requestCode}</p>}
  </div>;
}

export function RiderInstall({ state }: { state: DemoState }) {
  const [search] = useSearchParams();
  const code = search.get('code') ?? state.invite.code;
  return <><MobileHeader title={copy.app} back="/c/" className="mobile-header--rider" /><div className="mobile-content install-page rider-install">
    <h2>{copy.installFirst}</h2>
    <RiderInstallSteps />
    <RiderInstallCode code={code} />
    <Link className="button button--plain rider-install-skip" to={`/c/link?code=${encodeURIComponent(code)}`}>{copy.useWithoutInstall}</Link>
  </div></>;
}

export function RiderLink({ state, switchRider }: { state: DemoState; switchRider: (id: string) => void }) {
  const [search] = useSearchParams();
  const [code, setCode] = useState((search.get('code') ?? '').replace(/\D/g, '').slice(0, 8));
  const [prefilled, setPrefilled] = useState(code.length === 8);
  const [error, setError] = useState('');
  const [linked, setLinked] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const commit = useCommit();
  const navigate = useNavigate();
  const person = state.riders.find((rider) => rider.id === state.invite.riderId);
  const requiresConsent = person?.kind === 'adult' && code === state.invite.code;
  const autofilled = prefilled && !error;
  const invalid = error === copy.codeNotValid;
  const toast = useToast();
  return <><MobileHeader title={copy.app} back="/c/" className="mobile-header--rider" /><div className="mobile-content connection-page rider-pair">
    {linked ? <div className="rider-pair-success"><span className="success-circle"><Check size={34} /></span><h2>{copy.riderConnected(nameOf(state, linked))}</h2><p>{copy.locationOnce} {copy.demoLocationOnly}</p><Button onClick={() => { switchRider(linked); navigate('/c/'); }}>{copy.continue}</Button></div> :
      <form className="rider-pair-form" onSubmit={async (event) => {
        event.preventDefault();
        setError('');
        let riderId = '';
        await commit((current, now) => {
          if (code !== current.invite.code) { setError(copy.codeNotValid); return changed(current); }
          if (current.invite.used) { setError(copy.codeUsed); return changed(current); }
          if (current.invite.expiresAt <= now) { setError(copy.codeExpired); return changed(current); }
          riderId = current.invite.riderId;
          return changed({ ...current, invite: { ...current.invite, used: true }, riders: current.riders.map((rider) => rider.id === riderId ? { ...rider, connected: true } : rider) });
        });
        if (riderId) { setLinked(riderId); toast(copy.codeSent); }
      }}>
        <RiderPairHeading error={error} />
        <CodeInput label={copy.codeLabel} value={code} invalid={invalid} highlighted={autofilled} onChange={(value) => { setCode(value); setPrefilled(false); setError(''); }} />
        {requiresConsent && <label className="checkbox"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />{copy.consentSelf}</label>}
        {invalid && <p role="alert" className="rider-pair-error danger-text"><CircleAlert size={17} />{error}</p>}
        {autofilled ? <p className="small">{copy.codeAutofilled}</p> : <p className="small">{copy.codeExample} {state.invite.code.slice(0, 4)} {state.invite.code.slice(4)}</p>}
        <Button type="submit" disabled={code.length !== 8 || (requiresConsent && !consent)}>{copy.connect}</Button>
      </form>}
  </div></>;
}
