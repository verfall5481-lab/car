import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Session } from '@supabase/supabase-js';
import type { ReactNode } from 'react';
import { copy } from '../copy.ts';
import { createRoleClient, createRequestParams, dataObject, pickupActionRpc, RpcError } from './api.ts';
import type { LiveConfig, RoleClient, Surface } from './api.ts';
import { MapKeyContext } from './maps.tsx';
import { PickupOperationsContext, ToastContext, useToast } from '../ui.tsx';
import type { PickupOperations } from '../ui.tsx';
import type { DemoState } from '../demo-domain.ts';

const ClientContext = createContext<RoleClient | null>(null);
const ConfigContext = createContext<LiveConfig | null>(null);
export function useClient() {
  const value = useContext(ClientContext);
  if (!value) throw new Error('Role client not initialized');
  return value;
}
export function useLiveConfig() {
  const value = useContext(ConfigContext);
  if (!value) throw new Error('Live configuration not initialized');
  return value;
}

export function RoleProvider({ surface, config, children }: { surface: Surface; config: LiveConfig; children: ReactNode }) {
  const [client] = useState(() => createRoleClient(surface, config));
  const [query] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 5_000, gcTime: 30_000 } } }));
  const [toast, setToast] = useState('');
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 3500);
    return () => window.clearTimeout(timer);
  }, [toast]);
  return <ConfigContext.Provider value={config}><ClientContext.Provider value={client}><QueryClientProvider client={query}>
    <MapKeyContext.Provider value={config.mapKey || null}><ToastContext.Provider value={setToast}>
      {children}<div role="status" aria-live="polite" className={`toast ${toast ? 'toast--visible' : ''}`}>{toast}</div>
    </ToastContext.Provider></MapKeyContext.Provider>
  </QueryClientProvider></ClientContext.Provider></ConfigContext.Provider>;
}

export function useSession() {
  const { supabase } = useClient();
  const query = useQueryClient();
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const identity = useRef<string | null>(null);
  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, value) => {
      const next = value?.user.id ?? null;
      if (identity.current && identity.current !== next) query.clear();
      identity.current = next;
      setSession(value);
    });
    return () => subscription.unsubscribe();
  }, [supabase, query]);
  return session;
}

export function useConnection() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const sync = () => setOnline(navigator.onLine);
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    return () => { window.removeEventListener('online', sync); window.removeEventListener('offline', sync); };
  }, []);
  return online;
}

const errorText: Record<string, string> = {
  NETWORK: copy.offlineMessage, SERVER_UNAVAILABLE: copy.serverUnavailable, BAD_RESPONSE: copy.serverUnavailable,
  VALIDATION: copy.invalidInput, NOT_FOUND: copy.missing, FORBIDDEN: copy.restricted, NOT_ASSIGNEE: copy.restricted,
  NOT_AUTHENTICATED: copy.signInRequired, NOT_RIDER_DEVICE: copy.revokedDevice, NOT_CHILD_DEVICE: copy.revokedDevice, DEVICE_REVOKED: copy.revokedDevice,
  ACTIVE_REQUEST_EXISTS: copy.activeRequest, STALE_VERSION: copy.stale, ALREADY_TAKEN: copy.stale, INVALID_STATE: copy.stale,
  PICKUP_EXPIRED: copy.requestExpired, OFFER_NOT_PENDING: copy.offerUnavailable, NO_VALID_OFFER: copy.offerUnavailable,
  LOCATION_UNCONFIRMED: copy.locationNotConfirmed, LOCATION_CONSENT_REQUIRED: copy.consentRequired, CONSENT_REQUIRED: copy.consentRequired,
  CODE_EXPIRED: copy.codeExpired, INVITE_EXPIRED: copy.codeExpired, CODE_USED: copy.codeUsed, INVITE_USED: copy.codeUsed,
  INVALID_CODE: copy.codeNotValid, CODE_INVALID: copy.codeNotValid, INVITE_INVALID: copy.codeNotValid, RATE_LIMITED: copy.rateLimited,
  ALREADY_IN_FAMILY: copy.alreadyFamily, GEO_DENIED: copy.geoDenied, GEO_UNAVAILABLE: copy.geoUnavailable, MAP_UNAVAILABLE: copy.mapUnavailable,
  OTP_INVALID: copy.otpInvalid, OTP_SEND: copy.otpSendError, PUSH_UNAVAILABLE: copy.pushUnavailable, PUSH_DENIED: copy.pushDenied,
  PUSH_INSTALL: copy.pushInstall, PUSH_NOT_CONFIGURED: copy.pushNotConfigured,
  CAPTCHA_REQUIRED: copy.captchaError, DEVICE_LIMIT: copy.deviceLimit,
  PAIR_CODE_INVALID: copy.pairWrongCode, PAIR_CODE_EXPIRED: copy.pairCodeExpired,
  CANNOT_ACCEPT_OWN_OFFER: copy.restricted, ALREADY_EN_ROUTE: copy.stale,
  VEHICLE_BUSY: copy.busyVehicle, PARK_REQUIRED: copy.carParkRequired, NOT_VEHICLE: copy.carLinkLost, VEHICLE_REVOKED: copy.carLinkLost,
};
export function describeError(error: unknown) {
  return error instanceof RpcError ? errorText[error.code] ?? copy.genericError : copy.genericError;
}

export function useLiveMutation() {
  const client = useClient();
  const query = useQueryClient();
  const toast = useToast();
  const mutation = useMutation({ mutationFn: ({ name, args }: { name: string; args: Record<string, unknown> }) => client.rpc(name, args, dataObject),
    onSettled: () => query.invalidateQueries(),
  });
  async function run(name: string, args: Record<string, unknown> = {}, success?: string) {
    if (!navigator.onLine) { toast(copy.offlineMessage); return null; }
    try {
      const data = await mutation.mutateAsync({ name, args });
      if (success) toast(success);
      return data;
    } catch (error) { toast(describeError(error)); return null; }
  }
  return { run, pending: mutation.isPending };
}

export function LivePickupOperations({ children, state }: { children: ReactNode; state: DemoState }) {
  const client = useClient();
  const query = useQueryClient();
  const toast = useToast();
  const online = useConnection();
  const [pending, setPending] = useState(false);
  const value = useMemo<PickupOperations>(() => ({
    live: true,
    pending: pending || !online,
    async action(pickup, action, message) {
      if (!online) { toast(copy.offlineMessage); return { ok: false, state, code: 'NETWORK' }; }
      setPending(true);
      try {
        const [name, args] = pickupActionRpc(pickup.id, action, client.surface);
        const result = await client.rpc(name, args, dataObject);
        if (message) toast(message);
        return { ok: true as const, state, ignored: result.ignored === true ? true as const : undefined };
      } catch (error) { toast(describeError(error)); return { ok: false as const, state, code: error instanceof RpcError ? error.code : 'NETWORK' }; }
      finally { await query.invalidateQueries(); setPending(false); }
    },
    async request(requester, location, delay) {
      if (!online) { toast(copy.offlineMessage); return false; }
      setPending(true);
      try {
        await client.rpc(requester.kind === 'rider' ? 'rider_create_request' : 'member_create_request', createRequestParams(location, delay), dataObject);
        return true;
      } catch (error) { toast(describeError(error)); return false; }
      finally { await query.invalidateQueries(); setPending(false); }
    },
  }), [client, online, pending, query, state, toast]);
  return <PickupOperationsContext.Provider value={value}>{children}</PickupOperationsContext.Provider>;
}

export function useFamilyRealtime(familyId?: string) {
  const { supabase } = useClient();
  const query = useQueryClient();
  useEffect(() => {
    if (!familyId) return;
    let timer: number | undefined;
    const invalidate = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { void query.invalidateQueries(); }, 300);
    };
    const channel = supabase.channel(`family:${familyId}`);
    for (const table of ['family_feed_changes', 'pickup_offers']) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table, filter: `family_id=eq.${familyId}` }, invalidate);
    }
    channel.subscribe();
    return () => { window.clearTimeout(timer); void supabase.removeChannel(channel); };
  }, [familyId, supabase, query]);
}
