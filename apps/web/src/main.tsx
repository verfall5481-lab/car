import './styles.css';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { copy } from './copy.ts';
import { demoStore, useDemo } from './demo-store.ts';
import { DemoNav, GuardianTabs, ToastContext } from './ui.tsx';
import { RiderInfo, RiderInstall, RiderLink, RiderRequest } from './rider.tsx';
import { GuardianHome, GuardianNotifications, PickupDetail } from './guardian.tsx';
import { GuardianManagement } from './management.tsx';
import { VehicleScreen } from './vehicle.tsx';

const LiveApp = lazy(() => import('./live/app.tsx'));

function initialPersona(key: string, fallback: string) {
  try { return sessionStorage.getItem(key) ?? fallback; } catch { return fallback; }
}

function App() {
  const state = useDemo();
  const location = useLocation();
  const role = location.pathname.startsWith('/c') ? 'rider' : location.pathname.startsWith('/v') ? 'vehicle' : 'guardian';
  const [memberId, setMemberId] = useState(() => initialPersona('deriro-member', 'mom'));
  const [riderId, setRiderId] = useState(() => initialPersona('deriro-rider', 'minjun'));
  const [toast, setToast] = useState('');
  const timer = useRef<number | undefined>(undefined);
  const member = state.members.find((person) => person.id === memberId) ?? state.members[0];
  const connectedRiders = state.riders.filter((person) => person.connected);
  const rider = connectedRiders.find((person) => person.id === riderId) ?? connectedRiders[0];
  const riderMain = location.pathname === '/c/' || location.pathname === '/c';
  const guardianHome = location.pathname === '/p/' || location.pathname === '/p';
  const persona = role === 'rider' ? rider : member;
  const people = role === 'rider' ? connectedRiders : state.members;
  function changePersona(id: string, selectedRole = role) {
    const key = selectedRole === 'rider' ? 'deriro-rider' : 'deriro-member';
    try { sessionStorage.setItem(key, id); } catch { /* The selection can remain in this screen. */ }
    if (selectedRole === 'rider') setRiderId(id);
    else setMemberId(id);
  }
  const showToast = useCallback((message: string) => {
    window.clearTimeout(timer.current);
    setToast(message);
    timer.current = window.setTimeout(() => setToast(''), 3200);
  }, []);
  useEffect(() => {
    const interval = window.setInterval(() => { void demoStore.tick(); }, 1000);
    return () => { window.clearInterval(interval); window.clearTimeout(timer.current); };
  }, []);
  useEffect(() => {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
    if (role === 'rider' || role === 'guardian') void navigator.serviceWorker.register('/sw.js', { scope: role === 'rider' ? '/c/' : '/p/' }).catch(() => {});
  }, [role]);

  return <ToastContext.Provider value={showToast}>
    <DemoNav role={role} />
    {role === 'vehicle' ? <VehicleScreen state={state} /> : <main className={`mobile-app mobile-app--${role}`}>
      <Routes>
        <Route path="/" element={<Navigate to="/p/" replace />} />
        <Route path="/c" element={rider ? <RiderRequest key={rider.id} state={state} requester={{ kind: 'rider', id: rider.id }} /> : <Navigate to="/c/link" replace />} />
        <Route path="/c/me" element={rider ? <RiderInfo state={state} riderId={rider.id} /> : <Navigate to="/c/link" replace />} />
        <Route path="/c/install" element={<RiderInstall state={state} />} />
        <Route path="/c/start" element={<RiderInstall state={state} />} />
        <Route path="/c/link" element={<RiderLink state={state} switchRider={(id) => changePersona(id, 'rider')} />} />
        <Route path="/p" element={<GuardianHome state={state} member={member} />} />
        <Route path="/p/request" element={member.canRequest ? <RiderRequest key={member.id} state={state} requester={{ kind: 'member', id: member.id }} back="/p/" /> : <Navigate to="/p/" replace />} />
        <Route path="/p/pickups/:id" element={<PickupDetail state={state} member={member} />} />
        <Route path="/p/pickups/:id/handoff" element={<PickupDetail state={state} member={member} mode="handoff" />} />
        <Route path="/p/pickups/:id/location" element={<PickupDetail state={state} member={member} mode="location" />} />
        <Route path="/p/notifications" element={<GuardianNotifications state={state} />} />
        <Route path="/p/*" element={<GuardianManagement state={state} member={member} />} />
        <Route path="*" element={<Navigate to={role === 'rider' ? '/c/' : '/p/'} replace />} />
      </Routes>
      {role === 'guardian' && (guardianHome || ['/p/routines', '/p/family'].includes(location.pathname.replace(/\/$/, ''))) && <GuardianTabs />}
    </main>}
    {role !== 'vehicle' && persona && (riderMain || guardianHome) && <div className="persona-bar"><label>{copy.currentMember}<select value={persona.id} onChange={(event) => changePersona(event.target.value)}>{people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label><span>{copy.demoLabel}</span></div>}
    <div role="status" aria-live="polite" className={`toast ${toast ? 'toast--visible' : ''}`}>{toast}</div>
  </ToastContext.Provider>;
}

const isVehiclePreview = /^\/v(?:\/|$)/.test(window.location.pathname);
const configuredMode = import.meta.env.VITE_APP_MODE;
const liveMode = !isVehiclePreview && (configuredMode === 'live' || !configuredMode && import.meta.env.VITE_DEMO === 'false');
createRoot(document.getElementById('root')!).render(<BrowserRouter>{liveMode ? <Suspense fallback={<p className="boot-message" role="status">{copy.loading}</p>}><LiveApp /></Suspense> : <App />}</BrowserRouter>);
