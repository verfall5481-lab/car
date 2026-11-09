import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { Bell, CalendarCheck, CalendarDays, CarFront, Check, ChevronLeft, ChevronRight, CircleHelp, House, MapPin, Smartphone, Users } from 'lucide-react';
import { Link, NavLink } from 'react-router-dom';
import { copy } from './copy.ts';
import type { Actor, Coordinates, LocationInput, Pickup, PickupAction, PickupEvent, Requester } from '@deriro/contracts';
import { applyDemoAction, createRequest, demoNow } from './demo-domain.ts';
import type { ActionOptions, Change, DemoState, History } from './demo-domain.ts';
import { demoStore } from './demo-store.ts';
import { LiveMap } from './live/maps.tsx';

export const ToastContext = createContext<(message: string) => void>(() => {});
export type PickupOperations = {
  live: boolean; pending: boolean;
  action(pickup: Pickup, action: PickupAction, message?: string, options?: ActionOptions): Promise<Change>;
  request(requester: Requester, location: LocationInput, delay: number): Promise<boolean>;
};
export const PickupOperationsContext = createContext<PickupOperations | null>(null);
export const usePickupOperations = () => useContext(PickupOperationsContext);
export const useToast = () => useContext(ToastContext);
export const uid = () => crypto.randomUUID();
export const useClock = (state: DemoState) => {
  const [wall, setWall] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setWall(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return demoNow(state, wall);
};

const errorCopy: Record<string, string> = {
  STALE_VERSION: copy.stale, ALREADY_TAKEN: copy.stale, INVALID_STATE: copy.stale,
  FORBIDDEN: copy.restricted, NOT_ASSIGNEE: copy.restricted, ACTIVE_REQUEST: copy.activeRequest,
  VEHICLE_BUSY: copy.busyVehicle, LOCATION_UNCONFIRMED: copy.locationNotConfirmed,
  OFFLINE: copy.carOfflineError, NO_DRIVER: copy.noDriver, ROUTINE_ALREADY: copy.routineAlready,
};

export function useCommit() {
  const toast = useToast();
  return useCallback(async (run: (state: DemoState, now: number) => Change, message?: string) => {
    const result = await demoStore.change(run);
    if (!result.ok) toast(errorCopy[result.code] ?? copy.genericError);
    else if (message) toast(message);
    return result;
  }, [toast]);
}

export function usePickupAction() {
  const commit = useCommit();
  const live = usePickupOperations();
  return (pickup: Pickup, actor: Actor, action: PickupAction, message?: string, options?: ActionOptions) =>
    live ? live.action(pickup, action, message, options) : commit((state, now) => applyDemoAction(state, pickup.id, actor, action, now, options), message);
}

export function usePickupRequest() {
  const commit = useCommit();
  const live = usePickupOperations();
  const remote = live?.request;
  return useCallback(async (requester: Requester, location: LocationInput, delay: number) => {
    if (remote) return remote(requester, location, delay);
    const id = uid();
    return (await commit((state, now) => createRequest(state, requester, location, delay, now, id))).ok;
  }, [remote, commit]);
}

export function Button({ variant = 'primary', className = '', type = 'button', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'amber' | 'danger' | 'plain' | 'outline' }) {
  return <button {...props} type={type} className={`button button--${variant} ${className}`} />;
}

export function Badge({ children, tone = 'amber' }: { children: ReactNode; tone?: 'amber' | 'green' | 'red' | 'neutral' }) {
  return <span className={`badge badge--${tone}`}><span className="badge-dot" aria-hidden="true" />{children}</span>;
}

export function Status({ pickup }: { pickup: Pickup }) {
  const tone = pickup.status === 'open' || pickup.status === 'assigned' ? 'amber' :
    ['en_route', 'arrived', 'completed'].includes(pickup.status) ? 'green' :
    pickup.status === 'cancelled' ? 'neutral' : 'red';
  return <Badge tone={tone}>{copy.statuses[pickup.status]}</Badge>;
}

export function DemoNav({ role }: { role: keyof typeof copy.roles }) {
  return <div className={`demo-bar ${role === 'vehicle' ? 'demo-bar--dark' : ''}`}>
    <div className="demo-bar-inner">
      <div className="demo-brand"><span className="brand-mark"><House size={16} /></span><strong>{copy.app}</strong><span className="demo-flag">{copy.demo}</span></div>
      <nav aria-label={copy.roleNav}>
        <a aria-current={role === 'rider' ? 'page' : undefined} href="/c/"><Smartphone size={16} /><span>{copy.roles.rider}</span></a>
        <a aria-current={role === 'guardian' ? 'page' : undefined} href="/p/"><Users size={16} /><span>{copy.roles.guardian}</span></a>
        <a aria-current={role === 'vehicle' ? 'page' : undefined} href="/v/"><CarFront size={16} /><span>{copy.roles.vehicle}</span></a>
      </nav>
    </div>
  </div>;
}

export function MobileHeader({ title, back, children, className = '' }: { title?: string; back?: string; children?: ReactNode; className?: string }) {
  return <header className={`mobile-header ${className}`}><div>{back && <Link className="icon-button back-button" to={back} aria-label={copy.back}><ChevronLeft /></Link>}{title && <h1>{title}</h1>}</div>{children}</header>;
}

export function GuardianTabs() {
  return <nav className="guardian-tabs" aria-label={copy.roles.guardian}>
    <NavLink to="/p/" end><CalendarDays /><span>{copy.today}</span></NavLink>
    <NavLink to="/p/routines"><CalendarCheck /><span>{copy.routine}</span></NavLink>
    <NavLink to="/p/family"><Users /><span>{copy.family}</span></NavLink>
  </nav>;
}

export function HeaderBell() {
  return <Link className="icon-button" aria-label={copy.notification} to="/p/notifications"><Bell size={22} /></Link>;
}

export function Sheet({ title, close, children, className = '' }: { title: string; close: () => void; children: ReactNode; className?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  return <dialog ref={dialog} className={`sheet ${className}`} aria-labelledby={titleId}
    onCancel={(event) => { event.preventDefault(); close(); }}
    onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
    <div className="sheet-content"><span className="sheet-handle" /><h2 id={titleId}>{title}</h2>{children}</div>
  </dialog>;
}

export function CodeInput({ value, onChange, label, length = 8, invalid = false, disabled = false, highlighted = false }: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  length?: 6 | 8;
  invalid?: boolean;
  disabled?: boolean;
  highlighted?: boolean;
}) {
  const [selection, setSelection] = useState(0);
  return <label className={`code-cells${length === 8 ? ' code-cells--grouped' : ''}${highlighted ? ' code-cells--filled' : ''}${invalid ? ' code-cells--invalid' : ''}`}>
    <input type="text" className="code-cells-input" inputMode="numeric" autoComplete="one-time-code" aria-label={label} aria-invalid={invalid || undefined}
      value={value} disabled={disabled} onSelect={(event) => setSelection(event.currentTarget.selectionStart ?? 0)}
      onChange={(event) => onChange(event.currentTarget.value.replace(/[^0-9]/g, '').slice(0, length))} />
    {Array.from({ length }, (_, index) => <span aria-hidden="true" className="code-cell" data-caret={index === Math.min(selection, length - 1) || undefined} key={index}>{value[index]}</span>)}
  </label>;
}

export function Row({ icon, title, caption, to, onClick, trailing }: { icon?: ReactNode; title: ReactNode; caption?: ReactNode; to?: string; onClick?: () => void; trailing?: ReactNode }) {
  const content = <>{icon && <span className="row-icon">{icon}</span>}<span className="row-title">{title}{caption && <small>{caption}</small>}</span>{trailing && <span className="row-trailing">{trailing}</span>}{(to || onClick) && <ChevronRight size={16} className="row-chevron" />}</>;
  if (to) return <Link to={to} className="row">{content}</Link>;
  if (onClick) return <button type="button" onClick={onClick} className="row">{content}</button>;
  return <div className="row">{content}</div>;
}

export function Placeholder({ text }: { text: string }) {
  return <div className="empty"><span><CircleHelp size={23} /></span><p>{text}</p></div>;
}

export function RadioLine({ name, value, selected, change, label, hint }: { name: string; value: string; selected: string; change: (value: string) => void; label: string; hint?: string }) {
  return <label className="radio-line"><input type="radio" name={name} value={value} checked={selected === value} onChange={() => change(value)} /><span><strong>{label}</strong>{hint && <small>{hint}</small>}</span></label>;
}

export const pinOrigin = { lat: 37.4981, lng: 127.0441 };
type MapProps = { coords?: Coordinates; onMove?: (point: Coordinates) => void; marker?: string; uncertain?: boolean; live?: boolean };
export function MapPreview(props: MapProps) {
  const context = usePickupOperations();
  return props.live || context?.live ? <LiveMap {...props} /> : <DemoMap {...props} />;
}

function DemoMap({ coords = pinOrigin, onMove, marker, uncertain = false }: MapProps) {
  const drag = useRef<{ x: number; y: number; coords: Coordinates } | null>(null);
  const patternId = useId();
  const x = (coords.lng - pinOrigin.lng) * 8000;
  const y = (coords.lat - pinOrigin.lat) * -8000;
  function move(dx: number, dy: number, start = coords) {
    const lat = Math.max(pinOrigin.lat - 0.02, Math.min(pinOrigin.lat + 0.02, start.lat + dy / 8000));
    const lng = Math.max(pinOrigin.lng - 0.02, Math.min(pinOrigin.lng + 0.02, start.lng - dx / 8000));
    onMove?.({ lat, lng });
  }
  function begin(event: ReactPointerEvent<HTMLDivElement>) {
    if (!onMove || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, coords };
  }
  return <div className={`map ${onMove ? 'map--movable' : ''}`} aria-label={onMove ? `${copy.mapLabel}. ${copy.mapInstructions}` : copy.mapLabel}
    role={onMove ? 'group' : 'img'} tabIndex={onMove ? 0 : undefined} onPointerDown={begin}
    onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
    onPointerMove={(event) => { if (drag.current) move(event.clientX - drag.current.x, event.clientY - drag.current.y, drag.current.coords); }}
    onKeyDown={(event) => {
      const delta: Record<string, [number, number]> = { ArrowUp: [0, 12], ArrowDown: [0, -12], ArrowLeft: [12, 0], ArrowRight: [-12, 0] };
      if (onMove && delta[event.key]) { event.preventDefault(); move(...delta[event.key]); }
    }}>
    <svg viewBox="0 0 400 190" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs><pattern id={patternId} width="104" height="86" patternUnits="userSpaceOnUse" patternTransform="rotate(-22)">
        <rect width="104" height="86" fill="#e9e7e2" /><path d="M0 0h32v27H0zm56 41h48v45H56z" fill="#e2e5df" />
        <path d="M6 41h98M33 0v86m41-86v41M0 79h104" stroke="#fff" strokeWidth="4" />
      </pattern></defs>
      <g transform={`translate(${-x} ${-y})`}><rect x="-230" y="-230" width="860" height="650" fill={`url(#${patternId})`} />
        <path d="M23 49 76 21l22 36-60 22ZM304 131l35-24 35 38-32 26ZM138 158l24-23 18 20-28 26Z" fill="#d6e3ce" />
        <path d="M-190 191C-28 163 72 140 154 108s207-49 411-148M72-90C82 8 122 59 222 112s155 86 223 203" stroke="#fff" strokeWidth="10" fill="none" />
      </g>
    </svg>
    <span className={`map-marker ${uncertain ? 'map-marker--radius' : ''}`}><MapPin size={34} strokeWidth={2.5} /></span>
    {marker && <span className="map-marker-label">{marker}</span>}
    <span className="map-disclaimer">{copy.mapLabel}</span>
  </div>;
}

export const eventText: Record<History['event'], string> = {
  requested: copy.sentStep, accepted: copy.statuses.assigned, offered: copy.handoff, offer_accepted: copy.acceptOffer,
  offer_declined: copy.decline, offer_cancelled: copy.handoffCancel, offer_expired: copy.statuses.expired,
  took_over: copy.statuses.assigned, en_route: copy.statuses.en_route, en_route_undone: copy.undoDeparture, navigation_requested: copy.driveStart,
  nav_failed: copy.failNav, nav_ok: copy.navOpened, request_declined: copy.declineRequest,
  arrived: copy.statuses.arrived, arrival_ignored: copy.carIgnoredCallback, completed: copy.statuses.completed,
  cancelled: copy.statuses.cancelled, expired: copy.statuses.expired, location_confirmed: copy.confirmHere,
  rider_ready: copy.routineEarly, not_met_reported: copy.notMetRider, closed_unconfirmed: copy.statuses.closed_unconfirmed,
};

export function StepCheck({ done }: { done: boolean }) {
  return <span className={`step-check ${done ? 'is-done' : ''}`} aria-hidden="true">{done && <Check size={14} strokeWidth={3} />}</span>;
}
