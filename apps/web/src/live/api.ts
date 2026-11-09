import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { LocationInput, PickupAction } from '@deriro/contracts';
import { RpcError } from './errors.ts';

export { RpcError } from './errors.ts';

export type Surface = 'guardian' | 'rider';
export type LiveConfig = { url: string; publicKey: string; vapidKey?: string; mapKey?: string; captchaKey?: string; kakaoLogin?: boolean };

export function publicSupabaseKey(key: string) {
  if (/^sb_publishable_[\w-]+$/.test(key)) return true;
  try {
    const [, payload, signature] = key.split('.');
    return Boolean(signature) && JSON.parse(atob(payload.replaceAll('-', '+').replaceAll('_', '/'))).role === 'anon';
  } catch { return false; }
}

export function readLiveConfig(env: Record<string, unknown>): LiveConfig | null {
  const raw = typeof env.VITE_SUPABASE_URL === 'string' ? env.VITE_SUPABASE_URL.trim() : '';
  const publicKey = String(env.VITE_SUPABASE_PUBLISHABLE_KEY ?? env.VITE_SUPABASE_ANON_KEY ?? '').trim();
  try {
    const url = new URL(raw);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((!local || url.protocol !== 'http:') && url.protocol !== 'https:') return null;
    if (!publicSupabaseKey(publicKey) || url.username || url.password || url.search || url.hash) return null;
    return { url: url.toString().replace(/\/$/, ''), publicKey,
      vapidKey: typeof env.VITE_VAPID_PUBLIC_KEY === 'string' ? env.VITE_VAPID_PUBLIC_KEY.trim() : undefined,
      mapKey: String(env.VITE_KAKAO_JS_KEY ?? env.VITE_KAKAO_JAVASCRIPT_KEY ?? '').trim() || undefined,
      captchaKey: typeof env.VITE_TURNSTILE_SITE_KEY === 'string' ? env.VITE_TURNSTILE_SITE_KEY.trim() || undefined : undefined,
      kakaoLogin: env.VITE_ENABLE_KAKAO_LOGIN === 'true' };
  } catch { return null; }
}

const rpcEnvelope = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string(), detail: z.unknown().optional() }) }),
]);

export function decodeRpc<T>(input: unknown, schema: z.ZodType<T>): T {
  const envelope = rpcEnvelope.safeParse(input);
  if (!envelope.success) throw new RpcError('BAD_RESPONSE');
  if (!envelope.data.ok) throw new RpcError(envelope.data.error.code, envelope.data.error.detail);
  const result = schema.safeParse(envelope.data.data);
  if (!result.success) throw new RpcError('BAD_RESPONSE');
  return result.data;
}

export function createRoleClient(surface: Surface, config: LiveConfig) {
  const supabase = createClient(config.url, config.publicKey, {
    auth: { storageKey: surface === 'guardian' ? 'deriro-parent-auth' : 'deriro-child-auth', detectSessionInUrl: false, autoRefreshToken: true, persistSession: true, flowType: surface === 'guardian' && config.kakaoLogin ? 'pkce' : 'implicit' },
  });
  return {
    supabase,
    surface,
    async rpc<T>(name: string, parameters: Record<string, unknown>, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
      async function execute() {
        const query = supabase.rpc(name, parameters);
        const { data, error } = await (signal ? query.abortSignal(signal) : query);
        if (error) throw new RpcError(error.code === '40P01' ? 'RETRY' : error.code === 'PGRST301' ? 'NOT_AUTHENTICATED' : error.code === 'PGRST202' ? 'SERVER_UNAVAILABLE' : 'NETWORK');
        return decodeRpc(data, schema);
      }
      try { return await execute(); } catch (error) {
        if (error instanceof RpcError && error.code === 'RETRY' && !signal?.aborted) return execute();
        throw error;
      }
    },
  };
}

export type RoleClient = ReturnType<typeof createRoleClient>;
export const dataObject = z.record(z.string(), z.unknown());
const coordinates = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });
const locationSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('saved_place'), placeId: z.uuid() }),
  z.object({ source: z.literal('saved_point'), pickupPointId: z.uuid() }),
  coordinates.extend({ source: z.literal('map_pin'), note: z.string().max(40).optional(), label: z.string().max(40).optional(), currentLocation: coordinates.optional() }),
  coordinates.extend({ source: z.literal('gps'), accuracyM: z.number().nonnegative(), label: z.string().max(40).optional() }),
]);

export function createRequestParams(location: LocationInput, delay: number): Record<string, unknown> {
  const parsed = locationSchema.safeParse(location);
  if (!parsed.success || ![0, 10, 20, 30].includes(delay)) throw new RpcError('VALIDATION');
  const input = parsed.data;
  const p_wanted_in_min = delay;
  switch (input.source) {
    case 'saved_place': return { p_wanted_in_min, p_place_id: input.placeId };
    case 'saved_point': return { p_wanted_in_min, p_pickup_point_id: input.pickupPointId };
    case 'gps': return { p_wanted_in_min, p_gps: { lat: input.lat, lng: input.lng, accuracy_m: input.accuracyM, label: input.label } };
    case 'map_pin': return { p_wanted_in_min, p_pin: { lat: input.lat, lng: input.lng, label: input.label, note: input.note,
      ...(input.currentLocation ? { current_location: input.currentLocation } : {}) } };
  }
}

export function pickupActionRpc(id: string, action: PickupAction, surface: Surface = 'guardian'): [string, Record<string, unknown>] {
  const p_pickup_id = id;
  const versioned = { p_pickup_id, p_expected_version: 'expectedVersion' in action ? action.expectedVersion : undefined };
  switch (action.type) {
    case 'accept': return ['accept_pickup', { p_pickup_id, p_vehicle_id: action.vehicleId }];
    case 'offer': return ['offer_pickup', { ...versioned, p_to_member_id: action.toMemberId, p_note: action.note }];
    case 'respond_offer': return ['respond_offer', { p_expected_version: action.expectedVersion, p_offer_id: action.offerId, p_response: action.response, p_vehicle_id: action.vehicleId }];
    case 'cancel_offer': return ['cancel_offer', { p_expected_version: action.expectedVersion, p_offer_id: action.offerId }];
    case 'take_over': return ['take_over', { ...versioned, p_vehicle_id: action.vehicleId }];
    case 'depart': return ['mark_en_route', versioned];
    case 'undo_en_route': return ['undo_en_route', versioned];
    case 'arrive': return action.source === 'manual' ? ['mark_arrived', { ...versioned, p_source: action.source }] :
      ['mark_arrived', { p_pickup_id, p_source: action.source, p_nav_session_id: action.sessionId, p_destination_revision: action.destinationRevision }];
    case 'board': return [surface === 'rider' ? 'rider_mark_boarded' : 'mark_completed', versioned];
    case 'cancel': return surface === 'rider' ? ['rider_cancel_request', versioned] : action.reason === 'skipped' ? ['skip_occurrence', versioned] : ['cancel_pickup', { ...versioned, p_reason: action.reason }];
    case 'ready': return ['rider_ready_early', versioned];
    case 'not_met': return ['rider_report_not_met', versioned];
    case 'confirm_location': return ['confirm_location', { ...versioned, p_lat: action.destination.lat, p_lng: action.destination.lng, p_label: action.destination.label, p_place_id: action.destination.placeId }];
    default: throw new RpcError('FORBIDDEN');
  }
}

export function sameRoleReturn(value: string | null, origin: string) {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/p/';
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || !url.pathname.startsWith('/p/') || ['/p/login', '/p/auth/callback'].includes(url.pathname.replace(/\/$/, ''))) return '/p/';
    return url.pathname + url.search + url.hash;
  } catch { return '/p/'; }
}
