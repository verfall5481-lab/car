import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';

// The live web vehicle simulator (SPEC 23.8) against a mocked Supabase Auth and PostgREST on 127.0.0.1:56789.
// The mock follows the SQL contract in docs/backend-api.md and supabase/migrations for the vehicle RPCs it serves.
const liveUrl = 'http://127.0.0.1:5176';
const familyId = '20000000-0000-4000-8000-000000000001';
const dad = '20000000-0000-4000-8000-000000000002';
const mom = '20000000-0000-4000-8000-000000000003';
const riderId = '20000000-0000-4000-8000-000000000004';
const placeId = '20000000-0000-4000-8000-000000000005';
const pickupId = '20000000-0000-4000-8000-000000000006';
const vehicleId = '20000000-0000-4000-8000-000000000007';
const offerId = '20000000-0000-4000-8000-000000000008';
const vehicleUser = '20000000-0000-4000-8000-000000000009';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const startedAt = new Date().toISOString();

type Call = { name: string; body: Record<string, unknown>; at: number };
type Status = 'open' | 'assigned' | 'en_route' | 'arrived' | 'completed';

function anonymousSession() {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const user = { id: vehicleUser, role: 'authenticated', aud: 'authenticated', email: '', app_metadata: {}, user_metadata: {}, created_at: startedAt, is_anonymous: true };
  const claims = { sub: vehicleUser, exp: Math.floor(Date.now() / 1000) + 3600, is_anonymous: true, role: 'authenticated' };
  return { user, access_token: `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}.signature`, refresh_token: 'refresh-vehicle', expires_in: 3600, token_type: 'bearer' };
}

const member = (id: string, name: string, role: string) => ({ id, family_id: familyId, display_name: name, role, can_drive: true, can_request: true, left_at: null });

/** A stateful stand-in for the vehicle RPCs: pairing, feed, state uploads, departure, navigation result, arrival, boarding. */
class MockVehicleBackend {
  calls: Call[] = [];
  paired = false;
  hasPickup = false;
  declined = false;
  status: Status = 'open';
  /** Who holds the pickup once it is taken; this car's driver unless a guardian won the race. */
  assignee = { id: dad, name: '아빠' };
  /** V-03: a guardian who takes the request after this car drew its card and before its "출발하고 안내" arrives. */
  raceWinner: { id: string; name: string } | null = null;
  version = 1;
  session: string | null = null;
  navStatus = 'none';
  lastAction: string | null = null;

  constructor(options: { hasPickup?: boolean } = {}) {
    this.hasPickup = options.hasPickup ?? false;
  }

  named(name: string) {
    return this.calls.filter((call) => call.name === name);
  }

  /** The server's parked check: gear P collected within the last 30 seconds (pickup_rpc.sql, vehicle_set_driver). */
  parkedNow() {
    const last = this.named('upsert_vehicle_state').at(-1);
    if (!last || last.body.p_gear !== 'P') return false;
    const collected = Date.parse(String(last.body.p_collected_at));
    return collected <= Date.now() && collected >= Date.now() - 30_000;
  }

  row() {
    const open = this.status === 'open';
    // A pickup a guardian took by phone has no car and has not departed.
    const byPhone = this.status === 'assigned';
    const at = (when: boolean) => when ? startedAt : null;
    return {
      id: pickupId, family_id: familyId, rider_id: riderId, rider_member_id: null, rider_name: '할머니', child_name: '할머니',
      status: this.status, source: 'request', routine_id: null, occurrence_date: null, is_customized: false,
      assignee_member_id: open ? null : this.assignee.id, assignee_display_name: open ? null : this.assignee.name,
      vehicle_id: open || byPhone ? null : vehicleId,
      place_id: placeId, pickup_point_id: null, location_source: 'saved_place', location_confirmed: true,
      dest_lat: 37.501, dest_lng: 127.031, dest_label: '도서관', pin_note: null,
      version: this.version, assignment_round: open ? 0 : 1, destination_revision: 1,
      nav_session_id: this.session, nav_destination_revision: this.session ? 1 : null, nav_status: this.navStatus, last_start_action_id: this.lastAction,
      wanted_at: startedAt, created_at: startedAt, updated_at: startedAt, accepted_at: at(!open), en_route_at: at(!open && !byPhone),
      arrived_at: at(this.status === 'arrived' || this.status === 'completed'), arrived_source: null,
      completed_at: this.status === 'completed' ? new Date().toISOString() : null, cancelled_at: null, cancel_reason: null, expired_at: null,
      closed_unconfirmed_at: null, rider_ready_at: null, not_met_reported_at: null, cancelled_by_kind: null, completed_by_kind: null,
      routine_offer_created_at: null,
    };
  }

  feed() {
    const parked = this.parkedNow();
    const row = this.row();
    const guiding = this.status === 'en_route' || this.status === 'arrived';
    const cards = this.hasPickup && this.status === 'open' && !this.declined ? [{
      ...row, kind: 'child_request', pickup_id: pickupId, offer_id: offerId, offer_note: null, from_name: null,
      dest: { lat: row.dest_lat, lng: row.dest_lng, label: row.dest_label, note: null }, accuracy_m: null, wanted_in_min: 0, requested_ago_sec: 30,
      required_km: 4.2, required_is_estimate: true, primary_action: 'start_now', secondary_action: 'decline', urgency: 'high',
    }] : [];
    const lastState = this.named('upsert_vehicle_state').at(-1)?.body;
    return {
      vehicle: {
        id: vehicleId, family_id: familyId, nickname: '우리 차', family_name: '우리 가족', revoked_at: null,
        current_driver_member_id: dad, current_driver: { id: dad, display_name: '아빠' },
        active_pickup_id: guiding ? pickupId : null, active_nav_session_id: guiding ? this.session : null, active_destination_revision: guiding ? 1 : null,
      },
      drivers: [member(dad, '아빠', 'guardian'), member(mom, '엄마', 'owner')],
      state: lastState ? { vehicle_id: vehicleId, gear: lastState.p_gear, range_km: lastState.p_range_km, collected_at: lastState.p_collected_at,
        is_demo_value: lastState.p_is_demo_value, is_stale: false } : null,
      range: { verdict: 'check_required', required_km: null, range_km: null, computable: 0, total: 0 },
      cards,
      active_trip: guiding ? { ...row, pickup_id: pickupId, nav_session_id: this.session, destination_revision: 1 } : null,
      // The server sends the day list only while parked; it also lists a request this driver declined.
      today: parked && this.hasPickup ? [row] : [],
      alerts: [],
      nearby_places: parked ? [{ id: placeId, family_id: familyId, label: '도서관', kind: 'other', lat: 37.501, lng: 127.031, radius_m: 150, archived_at: null, distance_m: 0 }] : [],
      server_time: new Date().toISOString(),
    };
  }

  answer(name: string, body: Record<string, unknown>): { ok: true; data: unknown } | { ok: false; error: { code: string; detail: object } } {
    const ok = (data: unknown) => ({ ok: true as const, data });
    const fail = (code: string, detail: object = {}) => ({ ok: false as const, error: { code, detail } });
    const start = () => ({ pickup: this.row(), nav_session_id: this.session, destination_revision: 1, dest: { lat: 37.501, lng: 127.031, label: '도서관', note: null } });
    switch (name) {
      case 'vehicle_pair_start':
        return this.paired ? fail('INVALID_STATE') : ok({ code: 'K7Q2M9', url: '/p/vehicles/pair?code=K7Q2M9', expires_at: new Date(Date.now() + 600_000).toISOString() });
      case 'vehicle_pair_status':
        return ok(this.paired ? { paired: true, vehicle: { id: vehicleId, family_id: familyId, nickname: '우리 차' } } : { paired: false });
      case 'vehicle_get_feed':
        return this.paired ? ok(this.feed()) : fail('NOT_VEHICLE');
      case 'upsert_vehicle_state': {
        if (Date.parse(String(body.p_collected_at)) > Date.now() + 30_000) return fail('VALIDATION');
        return ok({ state: { gear: body.p_gear, range_km: body.p_range_km, collected_at: body.p_collected_at, is_demo_value: body.p_is_demo_value, is_stale: false }, alert: null });
      }
      case 'vehicle_start_now': {
        if (this.status === 'en_route' && body.p_action_id === this.lastAction) return ok(start());
        if (this.status === 'open' && this.raceWinner) {
          this.status = 'assigned';
          this.assignee = this.raceWinner;
          this.version++;
        }
        // 8.3.1: a car that is not the trip's car hears who holds it, before the version check; nothing is written.
        if (this.status === 'assigned' && this.assignee.id !== dad) return fail('ALREADY_TAKEN', { by: this.assignee.name });
        if (body.p_expected_version !== this.version) return fail('STALE_VERSION');
        if (this.status === 'open') {
          this.status = 'en_route';
          this.version++;
        } else if (this.status !== 'en_route') return fail('INVALID_STATE');
        this.session = crypto.randomUUID();
        this.navStatus = 'requested';
        this.lastAction = String(body.p_action_id);
        return ok(start());
      }
      case 'report_nav_result':
        if (this.status === 'en_route' && body.p_nav_session_id === this.session && this.navStatus === 'requested') this.navStatus = String(body.p_result);
        return ok({});
      case 'mark_arrived': {
        if (body.p_source === 'nav_callback') {
          if (this.status !== 'en_route' || body.p_nav_session_id !== this.session || body.p_destination_revision !== 1) return ok({ ignored: true });
        } else if (body.p_expected_version !== this.version) return fail('STALE_VERSION');
        if (this.status !== 'en_route') return fail('INVALID_STATE');
        this.status = 'arrived';
        this.version++;
        return ok({ pickup: this.row() });
      }
      case 'mark_completed':
        if (!this.parkedNow()) return fail('FORBIDDEN');
        if (body.p_expected_version !== this.version) return fail('STALE_VERSION');
        if (this.status !== 'arrived') return fail('INVALID_STATE');
        this.status = 'completed';
        this.version++;
        return ok({ pickup: this.row() });
      case 'vehicle_decline':
        if (body.p_expected_version !== this.version) return fail('STALE_VERSION');
        this.declined = true;
        return ok({});
      default:
        return fail('UNEXPECTED');
    }
  }
}

async function stubBackend(context: BrowserContext, backend: MockVehicleBackend) {
  await context.route('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit', (route) => route.fulfill({
    contentType: 'application/javascript', body: `window.turnstile = {render(el, options) { setTimeout(() => options.callback('test-captcha-token'), 0); return 'test-widget'; }, remove() {}};`,
  }));
  await context.route('http://127.0.0.1:56789/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, GET, OPTIONS' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
    const name = path.split('/').at(-1)!;
    backend.calls.push({ name, body, at: Date.now() });
    if (path === '/auth/v1/signup') return route.fulfill({ status: 200, headers, json: anonymousSession() });
    if (!path.startsWith('/rest/v1/rpc/')) return route.fulfill({ status: 404, headers, json: { message: 'Unexpected test request', code: 'PGRST202' } });
    return route.fulfill({ status: 200, headers, json: backend.answer(name, body) });
  });
}

async function pair(page: Page, backend: MockVehicleBackend) {
  await page.goto(`${liveUrl}/v/`);
  await expect(page.getByRole('heading', { name: '가족 휴대폰으로 연결해요' })).toBeVisible();
  await page.getByRole('button', { name: '연결 코드 만들기' }).click();
  await expect(page.locator('.vehicle-pair-code strong')).toHaveText('K7Q-2M9');
  // The guardian confirms the code on P-14; the car notices through vehicle_pair_status.
  backend.paired = true;
  await expect(page.getByRole('heading', { name: '가족 휴대폰으로 연결해요' })).toHaveCount(0);
}

function expectDemoUploads(backend: MockVehicleBackend) {
  const uploads = backend.named('upsert_vehicle_state');
  expect(uploads.length).toBeGreaterThan(0);
  for (const { body } of uploads) {
    expect(Object.keys(body).sort()).toEqual(['p_collected_at', 'p_gear', 'p_is_demo_value', 'p_range_km']);
    expect(body.p_is_demo_value).toBe(true);
    expect(['P', 'D']).toContain(body.p_gear);
  }
}

const screen = (page: Page) => page.locator('.vehicle-screen');
const simulator = (page: Page) => page.getByRole('region', { name: '웹 차량 시뮬레이터' });

test('live vehicle pairs with the code shown on the car and reaches the home screen', async ({ context, page }) => {
  const backend = new MockVehicleBackend();
  await stubBackend(context, backend);
  await page.goto(`${liveUrl}/v/`);
  await expect(page.getByRole('heading', { name: '가족 휴대폰으로 연결해요' })).toBeVisible();
  await expect(simulator(page).getByText('실제 서버 세션')).toBeVisible();
  await expect(simulator(page).getByText(/기어와 주행가능거리는 데모 값으로 보내고, 내비 안내와 도착 콜백은 시뮬레이션이에요/)).toBeVisible();
  await expect(page.getByText('웹 차량 시뮬레이터 · 실제 서버 연결')).toBeVisible();
  // Opening the page creates no anonymous user; the car asks for a code explicitly.
  expect(backend.calls.some((call) => call.name === 'signup')).toBe(false);
  await page.getByRole('button', { name: '연결 코드 만들기' }).click();
  await expect(page.locator('.vehicle-pair-code strong')).toHaveText('K7Q-2M9');
  await expect(screen(page).getByRole('img', { name: '연결 QR 코드' })).toBeVisible();
  await expect(screen(page).getByText(/\d+분 \d{2}초 남음/)).toBeVisible();
  await expect(simulator(page).getByRole('link', { name: '보호자 화면에서 연결 열기' })).toHaveAttribute('href', `${liveUrl}/p/vehicles/pair?code=K7Q2M9`);
  expect(backend.named('signup')[0]?.body.gotrue_meta_security).toEqual({ captcha_token: 'test-captcha-token' });
  expect(backend.named('vehicle_pair_start')).toHaveLength(1);
  await expect.poll(() => backend.named('vehicle_pair_status').length).toBeGreaterThan(0);
  expect(backend.named('vehicle_get_feed')).toHaveLength(0);

  backend.paired = true;
  await expect(screen(page).getByRole('heading', { name: '오늘 남은 픽업이 없어요' })).toBeVisible();
  await expect(page.locator('.toast')).toHaveText('우리 가족에 연결됐어요.');
  await expect(screen(page).getByText('운전자 아빠')).toBeVisible();
  await expect(screen(page).getByText('데모 값')).toBeVisible();
  await expect.poll(() => backend.named('upsert_vehicle_state').length).toBeGreaterThan(0);
  expectDemoUploads(backend);
  expect(await page.evaluate(() => Boolean(localStorage.getItem('deriro-vehicle-auth')))).toBe(true);
  expect(await page.evaluate(() => [localStorage.getItem('deriro-parent-auth'), localStorage.getItem('deriro-child-auth'), localStorage.getItem('deriro:local-demo:v1')])).toEqual([null, null, null]);
});

test('"출발하고 안내" sends an action id, a navigation failure keeps the trip en route and retry opens a new session', async ({ context, page }) => {
  const backend = new MockVehicleBackend({ hasPickup: true });
  await stubBackend(context, backend);
  await pair(page, backend);
  await expect(screen(page).getByRole('heading', { name: '할머니가 데리러 와 달래요' })).toBeVisible();
  await screen(page).getByRole('button', { name: '출발하고 안내' }).click();
  await expect(screen(page).getByRole('heading', { name: '할머니에게 가는 중' })).toBeVisible();
  const [first] = backend.named('vehicle_start_now');
  // 8.3.1: only a handoff card sends its offer ID. The request card carries the family-wide offer's ID and sends none.
  expect(first.body).toEqual({ p_pickup_id: pickupId, p_expected_version: 1, p_action_id: expect.stringMatching(uuid) });
  const firstSession = backend.session!;
  await expect(simulator(page).getByText('안내 결과를 기다리고 있어요')).toBeVisible();
  await expect(simulator(page).getByText(`안내 세션 ${firstSession.slice(0, 8)} · 목적지 버전 1`)).toBeVisible();

  await simulator(page).getByRole('button', { name: '안내 실패' }).click();
  await expect(screen(page).getByText('내비를 열지 못했어요')).toBeVisible();
  expect(backend.named('report_nav_result')[0].body).toEqual({ p_pickup_id: pickupId, p_nav_session_id: firstSession, p_result: 'failed', p_error_code: 'WEB_SIMULATED_FAILURE' });
  // Departure stands: the trip is still en route and nothing was undone.
  await expect(screen(page).getByRole('heading', { name: '할머니에게 가는 중' })).toBeVisible();
  expect(backend.status).toBe('en_route');
  expect(backend.calls.some((call) => call.name === 'undo_en_route')).toBe(false);
  await expect(simulator(page).getByText('안내 실패로 기록됐어요')).toBeVisible();

  await screen(page).getByRole('button', { name: '다시 시도' }).click();
  await expect(simulator(page).getByText('안내 결과를 기다리고 있어요')).toBeVisible();
  const retry = backend.named('vehicle_start_now')[1];
  expect(retry.body.p_action_id).toEqual(expect.stringMatching(uuid));
  expect(retry.body.p_action_id).not.toBe(first.body.p_action_id);
  expect(retry.body.p_expected_version).toBe(2);
  expect(backend.session).not.toBe(firstSession);
  await expect(simulator(page).getByText(`안내 세션 ${backend.session!.slice(0, 8)} · 목적지 버전 1`)).toBeVisible();
  await expect(screen(page).getByRole('button', { name: '도착했어요' })).toBeVisible();
  await expect(screen(page).getByRole('button', { name: '안내 다시 열기' })).toBeVisible();
  expectDemoUploads(backend);
});

test('manual arrival is not boarding; boarding is held while driving and sent after a fresh parked state', async ({ context, page }) => {
  const backend = new MockVehicleBackend({ hasPickup: true });
  await stubBackend(context, backend);
  await pair(page, backend);
  await screen(page).getByRole('button', { name: '출발하고 안내' }).click();
  await simulator(page).getByRole('button', { name: '안내 성공' }).click();
  await expect(simulator(page).getByText('안내 성공으로 기록됐어요')).toBeVisible();
  await screen(page).getByRole('button', { name: '도착했어요' }).click();
  await expect(screen(page).getByRole('heading', { name: '도착했어요' })).toBeVisible();
  expect(backend.named('mark_arrived')[0].body).toEqual({ p_pickup_id: pickupId, p_expected_version: 2, p_source: 'manual' });
  expect(backend.status).toBe('arrived');

  // V-00 while driving: one card, at most two buttons, no parked-only screens, and no boarding.
  await simulator(page).getByRole('button', { name: '주행 (D)' }).click();
  await expect(screen(page).getByText('주행 중')).toBeVisible();
  await expect(screen(page).getByText('차를 세우고 탑승을 확인해 주세요')).toBeVisible();
  await expect(screen(page).getByRole('button', { name: '태웠어요' })).toBeDisabled();
  expect(await screen(page).locator('.vehicle-actions .button').count()).toBeLessThanOrEqual(2);
  await expect(page.getByRole('button', { name: '오늘 목록' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '설정' })).toHaveCount(0);
  await expect.poll(() => backend.named('upsert_vehicle_state').at(-1)?.body.p_gear).toBe('D');
  expect(backend.calls.some((call) => call.name === 'mark_completed')).toBe(false);

  await simulator(page).getByRole('button', { name: '주차 (P)' }).click();
  await screen(page).getByRole('button', { name: '태웠어요' }).click();
  await expect(screen(page).getByRole('heading', { name: '탑승 확인됨' })).toBeVisible();
  const completedAt = backend.calls.findIndex((call) => call.name === 'mark_completed');
  const parkedUpload = backend.calls.slice(0, completedAt).reverse().find((call) => call.name === 'upsert_vehicle_state')!;
  expect(parkedUpload.body.p_gear).toBe('P');
  expect(backend.calls[completedAt].at - Date.parse(String(parkedUpload.body.p_collected_at))).toBeLessThan(30_000);
  expect(backend.calls[completedAt].body).toEqual({ p_pickup_id: pickupId, p_expected_version: 3 });
  expect(backend.status).toBe('completed');
  expectDemoUploads(backend);
});

test('a late arrival callback from an older navigation session is ignored; the current one arrives', async ({ context, page }) => {
  const backend = new MockVehicleBackend({ hasPickup: true });
  await stubBackend(context, backend);
  await pair(page, backend);
  await screen(page).getByRole('button', { name: '출발하고 안내' }).click();
  await expect(screen(page).getByRole('heading', { name: '할머니에게 가는 중' })).toBeVisible();
  const olderSession = backend.session!;
  await screen(page).getByRole('button', { name: '안내 다시 열기' }).click();
  await expect.poll(() => backend.session).not.toBe(olderSession);
  await expect(simulator(page).getByText(`안내 세션 ${backend.session!.slice(0, 8)} · 목적지 버전 1`)).toBeVisible();

  await simulator(page).getByRole('button', { name: '이전 안내 콜백' }).click();
  await expect(page.locator('.toast')).toHaveText('이전 안내 콜백을 무시했어요.');
  expect(backend.named('mark_arrived')[0].body).toEqual({ p_pickup_id: pickupId, p_source: 'nav_callback', p_nav_session_id: olderSession, p_destination_revision: 1 });
  await expect(screen(page).getByRole('heading', { name: '할머니에게 가는 중' })).toBeVisible();
  expect(backend.status).toBe('en_route');

  await simulator(page).getByRole('button', { name: '현재 안내 콜백' }).click();
  await expect(page.locator('.toast')).toHaveText('도착 콜백을 반영했어요.');
  await expect(screen(page).getByRole('heading', { name: '도착했어요' })).toBeVisible();
  expect(backend.named('mark_arrived')[1].body).toEqual({ p_pickup_id: pickupId, p_source: 'nav_callback', p_nav_session_id: backend.session, p_destination_revision: 1 });
});

test('a car that lost the race is told who took the trip and its card closes; nothing departs (V-03)', async ({ context, page }) => {
  const backend = new MockVehicleBackend({ hasPickup: true });
  await stubBackend(context, backend);
  await pair(page, backend);
  await expect(screen(page).getByRole('heading', { name: '할머니가 데리러 와 달래요' })).toBeVisible();
  // While driving the feed has no day list, so the name can only come from the answer's detail.by.
  await simulator(page).getByRole('button', { name: '주행 (D)' }).click();
  await expect.poll(() => backend.named('upsert_vehicle_state').at(-1)?.body.p_gear).toBe('D');
  await expect(screen(page).getByRole('heading', { name: '할머니가 데리러 와 달래요' })).toBeVisible();
  // Mom accepts on her phone while this car still shows the request card.
  backend.raceWinner = { id: mom, name: '엄마' };
  await screen(page).getByRole('button', { name: '출발하고 안내' }).click();
  await expect(page.locator('.toast')).toHaveText('엄마가 먼저 맡았어요');
  await expect(screen(page).getByRole('heading', { name: '할머니가 데리러 와 달래요' })).toHaveCount(0);
  await expect(screen(page).getByRole('heading', { name: '할머니에게 가는 중' })).toHaveCount(0);
  // One call, not retried; the trip stays mom's and the car opened no guidance.
  expect(backend.named('vehicle_start_now')).toHaveLength(1);
  expect(backend.status).toBe('assigned');
  expect(backend.assignee.id).toBe(mom);
  expect(backend.session).toBeNull();
  expect(backend.named('report_nav_result')).toHaveLength(0);
});

test('"못 가요" sends vehicle_decline and every simulated state is uploaded as a demo value', async ({ context, page }) => {
  const backend = new MockVehicleBackend({ hasPickup: true });
  await stubBackend(context, backend);
  await pair(page, backend);
  await screen(page).getByRole('button', { name: '못 가요' }).click();
  await expect(page.locator('.toast')).toHaveText('다른 가족에게 알렸어요');
  expect(backend.named('vehicle_decline')[0].body).toEqual({ p_pickup_id: pickupId, p_expected_version: 1 });
  // The day list still lists the open request, but the car no longer shows it.
  await expect(screen(page).getByRole('heading', { name: '할머니가 데리러 와 달래요' })).toHaveCount(0);
  await expect(screen(page).getByRole('heading', { name: '오늘 남은 픽업이 없어요' })).toBeVisible();

  await simulator(page).getByRole('slider', { name: '주행가능거리' }).fill('120');
  await expect.poll(() => backend.named('upsert_vehicle_state').at(-1)?.body.p_range_km).toBe(120);
  await expect(simulator(page).getByText(/마지막 업로드 P · 120km · 데모 값 · \d{2}:\d{2}:\d{2}/)).toBeVisible();
  await simulator(page).getByRole('button', { name: '주행 (D)' }).click();
  await expect.poll(() => backend.named('upsert_vehicle_state').at(-1)?.body.p_gear).toBe('D');
  await simulator(page).getByRole('button', { name: '주차 (P)' }).click();
  await expect.poll(() => backend.named('upsert_vehicle_state').at(-1)?.body.p_gear).toBe('P');
  expect(backend.named('upsert_vehicle_state').length).toBeGreaterThanOrEqual(3);
  expectDemoUploads(backend);
});

test('offline, the car keeps the last feed on screen and disables its actions', async ({ context, page }) => {
  const backend = new MockVehicleBackend({ hasPickup: true });
  await stubBackend(context, backend);
  await pair(page, backend);
  const depart = screen(page).getByRole('button', { name: '출발하고 안내' });
  await expect(depart).toBeEnabled();
  await context.setOffline(true);
  await expect(screen(page).locator('.vehicle-offline')).toHaveText('오프라인');
  await expect(screen(page).getByRole('heading', { name: '할머니가 데리러 와 달래요' })).toBeVisible();
  await expect(depart).toBeDisabled();
  await expect(screen(page).getByRole('button', { name: '못 가요' })).toBeDisabled();
  await context.setOffline(false);
  await expect(depart).toBeEnabled();
  await expect(screen(page).locator('.vehicle-offline')).toHaveCount(0);
  expect(backend.calls.some((call) => call.name === 'vehicle_start_now')).toBe(false);
});
