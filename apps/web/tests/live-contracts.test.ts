import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { createRequestParams, decodeRpc, pickupActionRpc, readLiveConfig, sameRoleReturn } from '../src/live/api.ts';
import { guardianState, overviewSchema, pickupSchema, riderState, riderStateSchema, todaySchema } from '../src/live/models.ts';
import { demoNow, nameOf, rangeEstimate } from '../src/demo-domain.ts';

function fixture(name: string) {
  return JSON.parse(readFileSync(new URL(`../../../supabase/tests/fixtures/${name}.json`, import.meta.url), 'utf8'));
}

const overview = decodeRpc(fixture('get_family_overview'), overviewSchema);
const today = decodeRpc(fixture('get_today'), todaySchema);
const detail = decodeRpc(fixture('get_pickup'), pickupSchema);
const linked = decodeRpc(fixture('rider_get_state'), riderStateSchema);

test('guardian projection accepts actual SQL and keeps pending sender and assignee distinct', () => {
  const state = guardianState(overview, today, detail, 100_000);
  const pickup = state.pickups.find((row) => row.id === detail.pickup.id)!;
  assert.equal(nameOf(state, pickup.requester.id), '할머니');
  assert.equal(nameOf(state, pickup.assigneeId), '아빠');
  assert.equal(nameOf(state, pickup.offer?.toMemberId), '엄마');
  assert.equal(pickup.offer?.status, 'pending');
  assert.equal(pickup.destination.note, '후문 벤치');
  assert.ok(state.history.some((event) => event.event === 'requested'));
  assert.ok(overview.devices.length);
  assert.ok(overview.consents.some((consent) => consent.purpose === 'rider_location'));
  assert.equal(detail.range?.verdict, 'low');
  assert.equal(detail.range?.required_km, detail.required_km);
  assert.equal(rangeEstimate(state, [pickup], { ...state.vehicle, range: null }).verdict, 'check');
});

test('guardian projection keeps rider phone numbers so a guardian can call after "not met"', () => {
  const [first, ...rest] = overview.riders;
  const withPhone = { ...overview, riders: [{ ...first, phone_e164: '+821012345678' }, ...rest] };
  const state = guardianState(withPhone, today, detail, 100_000);
  assert.equal(state.riders.find((rider) => rider.id === first.id)?.phone, '+821012345678');
  assert.equal(state.riders.find((rider) => rider.id !== first.id)?.phone, undefined);
});

test('rider projection accepts privacy-filtered SQL without assuming a known range or sharing phone data', () => {
  const state = riderState(linked, 100_000);
  const pickup = state.pickups[0];
  assert.equal(linked.actives[0].dest_lat, undefined);
  assert.equal(nameOf(state, pickup.requester.id), '할머니');
  assert.equal(nameOf(state, pickup.assigneeId), '아빠');
  assert.equal(state.pickupCapabilities?.[pickup.id].cancel, true);
  assert.equal(demoNow(state, 110_000), Date.parse(linked.server_time) + 10_000);
  assert.equal(rangeEstimate(state, [pickup], { ...state.vehicle, range: 600 }).verdict, 'check');
});

test('map pin carries optional current location with exact SQL keys', () => {
  assert.deepEqual(createRequestParams({ source: 'map_pin', lat: 37.5, lng: 127.1, note: '후문', currentLocation: { lat: 37.51, lng: 127.1 } }, 10), {
    p_wanted_in_min: 10, p_pin: { lat: 37.5, lng: 127.1, label: undefined, note: '후문', current_location: { lat: 37.51, lng: 127.1 } },
  });
  assert.throws(() => createRequestParams({ source: 'saved_place', placeId: 'invalid-id' }, 10), /VALIDATION/);
  assert.deepEqual(pickupActionRpc(detail.pickup.id, { type: 'board', expectedVersion: 3 }, 'rider'), ['rider_mark_boarded', { p_pickup_id: detail.pickup.id, p_expected_version: 3 }]);
  assert.deepEqual(pickupActionRpc(detail.pickup.id, { type: 'cancel', expectedVersion: 3, reason: 'resolved_by_phone' }), ['cancel_pickup', { p_pickup_id: detail.pickup.id, p_expected_version: 3, p_reason: 'resolved_by_phone' }]);
});

test('live config rejects secrets and login return stays in the guardian surface', () => {
  const origin = 'http://127.0.0.1:5176';
  assert.equal(readLiveConfig({ VITE_SUPABASE_URL: origin, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_no' }), null);
  assert.equal(readLiveConfig({ VITE_SUPABASE_URL: 'http://public.example', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test' }), null);
  assert.equal(readLiveConfig({ VITE_SUPABASE_URL: origin, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', VITE_KAKAO_JS_KEY: 'kakao-public' })?.mapKey, 'kakao-public');
  assert.equal(sameRoleReturn('/p/join?code=ABCD1234', origin), '/p/join?code=ABCD1234');
  for (const blocked of ['//outside.test/p/', '/\\outside.test/p/', '/c/link', '/p/../c/link', '/p/login']) assert.equal(sameRoleReturn(blocked, origin), '/p/');
});

test('worker scopes notifications and never caches code-bearing URLs', async () => {
  const origin = 'http://localhost:5176';
  const calls: string[] = [];
  const listeners: Record<string, (value: any) => void> = {};
  const self = {
    location: { origin }, registration: { scope: `${origin}/c/`, showNotification: async (_title: string, value: { data: { url: string } }) => { calls.push(value.data.url); } },
    clients: { matchAll: async () => [{ url: `${origin}/p/`, navigate: async () => { throw new Error('other surface'); } }], openWindow: async (url: string) => { calls.push(url); } },
    addEventListener: (name: string, listener: (value: any) => void) => { listeners[name] = listener; },
  };
  runInNewContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), { self, URL });
  let pending: Promise<unknown> | undefined;
  const waitUntil = (work: Promise<unknown>) => { pending = work; };
  listeners.push({ data: { json: () => ({ title: '픽업', body: '도착', url: '/p/pickups/other' }) }, waitUntil });
  await pending;
  listeners.notificationclick({ notification: { close() {}, data: { url: '/c/me' } }, waitUntil });
  await pending;
  listeners.fetch({ request: { url: `${origin}/c/start?code=12345678`, method: 'GET', mode: 'navigate' }, respondWith: () => { throw new Error('invite URL must not enter the cache'); } });
  assert.deepEqual(calls, [`${origin}/c/`, `${origin}/c/me`]);
});
