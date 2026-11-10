import { lazy, Suspense, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { CarFront, Smartphone, Users } from 'lucide-react';
import type { Session } from '@supabase/supabase-js';
import { copy } from '../copy.ts';
import { Button, GuardianTabs, MobileHeader, Row } from '../ui.tsx';
import { GuardianHome, PickupDetail } from '../guardian.tsx';
import { RiderRequest } from '../rider.tsx';
import { FamilySetup, GuardianLogin, GuardianOAuthCallback, InstallGuide, PairRider, PushSettings, Unlinked, privacyVersion, rememberReturn, retrieveReturn } from './accounts.tsx';
import { RpcError, readLiveConfig } from './api.ts';
import type { Surface } from './api.ts';
import { describeError, LivePickupOperations, RoleProvider, useClient, useConnection, useFamilyRealtime, useLiveMutation, useSession } from './context.tsx';
import { guardianState, mapMember, overviewSchema, pickupSchema, riderState, riderStateSchema, todaySchema } from './models.ts';
import { isStandalone, roleWorker, unsubscribePush } from './platform.ts';
import { LiveManagement } from './management.tsx';

function LoadingScreen() {
  return <><MobileHeader title={copy.app} /><div className="mobile-content loading-view" role="status" aria-live="polite"><p>{copy.loading}</p><span /><span /><span /></div></>;
}
function Failure({ error, retry }: { error: unknown; retry: () => void }) {
  return <><MobileHeader title={copy.app} /><div className="mobile-content stack"><p role="alert">{describeError(error)}</p><Button onClick={retry}>{copy.retry}</Button></div></>;
}
function LoginRedirect() {
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => { rememberReturn(location.pathname + location.search + location.hash); navigate('/p/login', { replace: true }); }, [location.pathname, location.search, location.hash, navigate]);
  return <LoadingScreen />;
}

function LoginReturn() {
  const navigate = useNavigate();
  useEffect(() => { navigate(retrieveReturn(), { replace: true }); }, [navigate]);
  return <LoadingScreen />;
}

function GuardianRoot() {
  const session = useSession();
  const location = useLocation();
  const path = location.pathname.replace(/\/$/, '');
  if (path === '/p/install') return <InstallGuide surface="guardian" />;
  if (path === '/p/auth/callback') return <GuardianOAuthCallback />;
  if (session === undefined) return <LoadingScreen />;
  if (!session || session.user.is_anonymous) return path === '/p/login' ? <GuardianLogin /> : <LoginRedirect />;
  if (path === '/p/login') return <LoginReturn />;
  return <GuardianDesk key={session.user.id} session={session} />;
}

function GuardianDesk({ session }: { session: Session }) {
  const client = useClient();
  const location = useLocation();
  const path = location.pathname.replace(/\/$/, '');
  const pickupRoute = path.match(/^\/p\/pickups\/([^/]+)(?:\/(handoff|location))?$/);
  const guardianId = session.user.id;
  const overview = useQuery({ queryKey: ['family', guardianId], queryFn: ({ signal }) => client.rpc('get_family_overview', {}, overviewSchema, signal) });
  const family = overview.data?.family.id;
  const showToday = path === '/p' || path === '/p/request' || path.startsWith('/p/vehicles/');
  const today = useQuery({ queryKey: ['today', guardianId, family], enabled: Boolean(family && showToday),
    queryFn: ({ signal }) => client.rpc('get_today', { p_days: 2 }, todaySchema, signal), refetchInterval: 30_000 });
  const detail = useQuery({ queryKey: ['pickup', guardianId, family, pickupRoute?.[1]], enabled: Boolean(family && pickupRoute),
    queryFn: ({ signal }) => client.rpc('get_pickup', { p_pickup_id: pickupRoute?.[1] }, pickupSchema, signal), refetchInterval: 30_000 });
  useFamilyRealtime(family);
  const noFamily = overview.error instanceof RpcError && ['NOT_GUARDIAN', 'NOT_IN_FAMILY', 'FAMILY_NOT_FOUND'].includes(overview.error.code);
  if (overview.isPending) return <LoadingScreen />;
  if (noFamily) return path === '/p/join' ? <FamilySetup key="join" join /> : path === '/p/onboarding' ? <FamilySetup /> : <Navigate to="/p/onboarding" replace />;
  if (!overview.data) return <Failure error={overview.error} retry={() => { void overview.refetch(); }} />;
  if (path === '/p/onboarding' || path === '/p/join') return <Navigate to="/p/notifications" replace />;
  if (showToday && today.isPending) return <LoadingScreen />;
  if (showToday && !today.data && today.isError) return <Failure error={today.error} retry={() => { void today.refetch(); }} />;
  if (pickupRoute && detail.isPending) return <LoadingScreen />;
  if (pickupRoute && !detail.data && detail.isError) return <Failure error={detail.error} retry={() => { void detail.refetch(); }} />;
  const state = guardianState(overview.data, today.data, detail.data, today.dataUpdatedAt);
  const member = mapMember(overview.data.me, overview.data.family.id);
  return <LivePickupOperations state={state}>
    {path === '/p' ? <GuardianHome state={state} member={member} /> :
      path === '/p/request' ? <MemberRequest state={state} member={member} allowed={Boolean(overview.data.me.location_consented_at)} /> :
      pickupRoute ? <PickupDetail key={pickupRoute[1]} state={state} member={member} mode={pickupRoute[2] as 'handoff' | 'location' | undefined} pickupId={pickupRoute[1]} /> :
      path === '/p/notifications' ? <PushSettings surface="guardian" /> :
      <LiveManagement overview={overview.data} today={today.data} state={state} path={path} />}
    {['/p', '/p/routines', '/p/family'].includes(path) && <GuardianTabs />}
  </LivePickupOperations>;
}

function MemberRequest({ state, member, allowed }: { state: ReturnType<typeof guardianState>; member: ReturnType<typeof mapMember>; allowed: boolean }) {
  const { run, pending } = useLiveMutation();
  if (!member.canRequest) return <Navigate to="/p/" replace />;
  if (allowed) return <RiderRequest state={state} requester={{ kind: 'member', id: member.id }} back="/p/" />;
  return <><MobileHeader title={copy.requestSelf} back="/p/" /><div className="mobile-content stack"><p>{copy.consentSelf}</p><Button disabled={pending} onClick={() => { void run('update_me', { p_consent: privacyVersion }); }}>{copy.confirm}</Button></div></>;
}

function RiderRoot() {
  const session = useSession();
  const location = useLocation();
  const path = location.pathname.replace(/\/$/, '');
  if (path === '/c/start' || path === '/c/install') return <InstallGuide surface="rider" hasCode={path === '/c/start'} />;
  if (path === '/c/link') return <PairRider revoked={location.state?.revoked === true} signedIn={session?.user.is_anonymous === true} />;
  if (session === undefined) return <LoadingScreen />;
  if (!session || !session.user.is_anonymous) return isStandalone() ? <Navigate to="/c/link" replace /> : <Unlinked />;
  return <RiderDesk key={session.user.id} userId={session.user.id} info={path === '/c/me'} />;
}

function RiderDesk({ userId, info }: { userId: string; info: boolean }) {
  const client = useClient();
  const query = useQueryClient();
  const result = useQuery({ queryKey: ['rider-state', userId], queryFn: ({ signal }) => client.rpc('rider_get_state', {}, riderStateSchema, signal),
    refetchInterval: (current) => current.state.data?.actives.some((pickup) => ['open', 'assigned', 'en_route', 'arrived'].includes(pickup.status)) ? 5000 : 60_000, refetchIntervalInBackground: false });
  const errorCode = result.error instanceof RpcError ? result.error.code : '';
  const revoked = ['NOT_RIDER_DEVICE', 'NOT_CHILD_DEVICE', 'DEVICE_REVOKED', 'NOT_AUTHENTICATED'].includes(errorCode);
  useEffect(() => { if (revoked) void unsubscribePush(client, true).catch(() => {}); }, [revoked, client]);
  if (revoked) return <Navigate to="/c/link" state={{ revoked: true }} replace />;
  if (result.isPending) return <LoadingScreen />;
  if (!result.data) return <Failure error={result.error} retry={() => { void query.invalidateQueries({ queryKey: ['rider-state'] }); }} />;
  const state = riderState(result.data, result.dataUpdatedAt);
  if (info) return <><MobileHeader title={copy.info} back="/c/" /><div className="mobile-content stack"><h2>{result.data.rider.display_name}</h2>
    <p>{copy.locationAtRequest}</p>{result.data.callable_guardians.map((person) => <Row title={person.display_name} key={person.id ?? person.display_name} />)}
    <PushSettings surface="rider" compact /><Link to="/c/install" className="button button--plain">{copy.installHelp}</Link></div></>;
  return <LivePickupOperations state={state}><RiderRequest key={result.data.rider.id} state={state} requester={{ kind: 'rider', id: result.data.rider.id }} /></LivePickupOperations>;
}

function SurfacePage({ surface }: { surface: Surface }) {
  const online = useConnection();
  useEffect(() => { try { void roleWorker(surface).catch(() => {}); } catch { /* The site still works without installation. */ } }, [surface]);
  return <main className={`mobile-app mobile-app--${surface} live-app`}>
    {!online && <div className="network-banner" role="status">{copy.offlineMessage}</div>}
    {surface === 'guardian' ? <GuardianRoot /> : <RiderRoot />}
  </main>;
}

const LiveVehicle = lazy(() => import('./vehicle.tsx'));
const liveVehicleEnabled = import.meta.env.VITE_LIVE_VEHICLE_SIM === 'true';

export default function LiveApp() {
  const location = useLocation();
  const config = readLiveConfig(import.meta.env);
  const vehicle = liveVehicleEnabled && /^\/v(?:\/|$)/.test(location.pathname);
  const surface: Surface = vehicle ? 'vehicle' : /^\/c(?:\/|$)/.test(location.pathname) ? 'rider' : 'guardian';
  if (location.pathname === '/') return <main className="mobile-app live-app"><MobileHeader title={copy.app} /><div className="mobile-content stack">
    <Row icon={<Users />} title={copy.roles.guardian} to="/p/" /><Row icon={<Smartphone />} title={copy.roles.rider} to="/c/" />
    {liveVehicleEnabled && <a className="row" href="/v/"><span className="row-icon"><CarFront /></span><span className="row-title">{copy.simHeading}</span></a>}
  </div></main>;
  if (!config) return <main className="mobile-app live-app"><MobileHeader title={copy.app} /><div className="mobile-content"><p role="alert">{copy.configUnavailable}</p></div></main>;
  if (surface === 'vehicle') {
    // The vehicle module creates its own role client once it has loaded.
    return (
      <Suspense fallback={<p className="boot-message">{copy.loading}</p>}>
        <LiveVehicle config={config} />
      </Suspense>
    );
  }
  return <RoleProvider key={surface} surface={surface} config={config}><SurfacePage surface={surface} /></RoleProvider>;
}
