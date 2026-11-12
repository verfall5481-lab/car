import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';

// SPEC 24.6 against a mocked Supabase Auth and PostgREST on 127.0.0.1:56789: the exact RPC bodies of
// declare_no_driver, ack_fallback, set_unavailable_day and upsert_place, and the feed fields the screens read.
const liveUrl = 'http://127.0.0.1:5176';
const familyId = '30000000-0000-4000-8000-000000000001';
const momId = '30000000-0000-4000-8000-000000000002';
const dadId = '30000000-0000-4000-8000-000000000003';
const riderId = '30000000-0000-4000-8000-000000000004';
const placeId = '30000000-0000-4000-8000-000000000005';
const pickupId = '30000000-0000-4000-8000-000000000006';
const startedAt = new Date().toISOString();
const seoulDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

const member = (id: string, name: string, role: string) => ({ id, family_id: familyId, display_name: name, role, can_drive: true, can_request: true, left_at: null,
  phone_e164: null, location_consented_at: startedAt });
const mom = member(momId, '엄마', 'owner');
const dad = member(dadId, '아빠', 'guardian');
const rider = { id: riderId, family_id: familyId, display_name: '민준', kind: 'child', consent_basis: 'guardian', phone_e164: '+821055550000' };
const family = { id: familyId, name: '우리 가족', timezone: 'Asia/Seoul' };

function session(isAnonymous: boolean) {
  const id = isAnonymous ? '30000000-0000-4000-8000-000000000008' : '30000000-0000-4000-8000-000000000007';
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const user = { id, role: 'authenticated', aud: 'authenticated', email: isAnonymous ? '' : 'mom@example.test', app_metadata: {}, user_metadata: {}, created_at: startedAt, is_anonymous: isAnonymous };
  return { user, access_token: `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: id, exp: Math.floor(Date.now() / 1000) + 3600, is_anonymous: isAnonymous, role: 'authenticated' })}.signature`,
    refresh_token: `refresh-${id}`, expires_in: 3600, token_type: 'bearer' };
}

type Call = { name: string; body: Record<string, unknown> };

/** One open request of 민준 to 수학학원 that nobody can drive (dad is off today), as the SQL feeds return it. */
class Backend {
  calls: Call[] = [];
  declared = false;
  acked = false;
  paired = false;
  placeNote: string | null = '학원 안에서 기다리기';
  days: { member_id: string; day: string }[] = [{ member_id: dadId, day: seoulDay }];

  named(name: string) { return this.calls.filter((call) => call.name === name); }

  place() {
    return { id: placeId, family_id: familyId, label: '수학학원', kind: 'academy', lat: 37.5001, lng: 127.0371, radius_m: 150, archived_at: null, fallback_note: this.placeNote };
  }

  row() {
    const declared = this.declared;
    return {
      id: pickupId, family_id: familyId, rider_id: riderId, rider_member_id: null, rider_name: '민준', child_name: '민준', status: declared ? 'cancelled' : 'open', source: 'request',
      routine_id: null, occurrence_date: null, is_customized: declared, assignee_member_id: null, assignee_display_name: null, vehicle_id: null, place_id: placeId,
      pickup_point_id: null, location_source: 'saved_place', location_confirmed: true, dest_lat: 37.5001, dest_lng: 127.0371, dest_label: '수학학원', pin_note: null,
      version: declared ? 2 : 1, assignment_round: 0, destination_revision: 1, nav_session_id: null, nav_destination_revision: null, nav_status: 'none',
      last_start_action_id: null, wanted_at: startedAt, created_at: startedAt, updated_at: startedAt, accepted_at: null, en_route_at: null, arrived_at: null,
      arrived_source: null, completed_at: null, cancelled_at: declared ? startedAt : null, expired_at: null, closed_unconfirmed_at: null, rider_ready_at: null,
      not_met_reported_at: null, cancelled_by_kind: declared ? 'guardian' : null, completed_by_kind: null, routine_offer_created_at: null,
      cancel_reason: declared ? 'no_driver' : null, fallback_note: declared ? '학원 안에서 기다리기' : null, fallback_by_member_id: declared ? momId : null,
      fallback_ack_at: this.acked ? new Date().toISOString() : null, fallback_by_name: declared ? '엄마' : null,
    };
  }

  guardianRow() {
    return { ...this.row(), offer: null, no_available_driver: !this.declared, unavailable_member_ids: this.days.filter((row) => row.day === seoulDay).map((row) => row.member_id),
      place_fallback_note: this.placeNote };
  }

  riderRow() {
    const { dest_lat: _lat, dest_lng: _lng, nav_session_id: _session, last_start_action_id: _action, ...row } = this.row();
    return { ...row, escalation_stage: 0, can_cancel: !this.declared, cancel_needs_confirm: false, can_report_not_met: false, nobody_available: !this.declared,
      wait_note: this.placeNote };
  }

  answer(name: string, body: Record<string, unknown>) {
    const ok = (data: unknown) => ({ ok: true, data });
    const fail = (code: string) => ({ ok: false, error: { code, detail: {} } });
    switch (name) {
      case 'get_family_overview':
        return ok({ family, me: mom, members: [mom, dad], riders: [rider], rider_devices: [], vehicles: [], places: [this.place()], pickup_points: [], routines: [] });
      case 'get_today':
        return ok({ active: this.declared ? [] : [this.guardianRow()], timeline: this.declared ? [this.guardianRow()] : [], pending_offers_to_me: [], alerts: [],
          server_time: new Date().toISOString(), unavailable_days: this.days, notification_failures: { sms_failed: 0 } });
      case 'get_pickup':
        return ok({ pickup: this.guardianRow(), offers: [], assignee: null, vehicle: null, required_km: null,
          events: [{ event_type: 'created', pickup_id: pickupId, actor_id: riderId, created_at: startedAt },
            ...(this.declared ? [{ event_type: 'no_driver', pickup_id: pickupId, actor_id: momId, created_at: startedAt }] : [])] });
      case 'declare_no_driver':
        if (body.p_expected_version !== 1) return fail('STALE_VERSION');
        this.declared = true;
        return ok({ pickup: this.row() });
      case 'ack_fallback':
        this.acked = true;
        return ok({ pickup: this.row() });
      case 'set_unavailable_day': {
        const others = this.days.filter((row) => !(row.member_id === momId && row.day === body.p_day));
        this.days = body.p_unavailable ? [...others, { member_id: momId, day: String(body.p_day) }] : others;
        return ok({ days: this.days, held_pickup_ids: [] });
      }
      case 'upsert_place':
        this.placeNote = String(body.p_fallback_note ?? '') || null;
        return ok({ place: this.place() });
      case 'claim_rider_invite':
        // A child's location consent was given by the guardian when the rider was added (P-12).
        this.paired = true;
        return ok({ rider, device_id: '30000000-0000-4000-8000-000000000009' });
      case 'rider_get_state':
        return this.paired ? ok({ rider, callable_guardians: [{ id: momId, display_name: '엄마', phone_e164: '+821012345678' }], places: [this.place()], pickup_points: [],
          actives: [this.riderRow()], today: [], server_time: new Date().toISOString() }) : fail('NOT_RIDER_DEVICE');
      default:
        return null;
    }
  }
}

async function stub(context: BrowserContext, backend: Backend) {
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
    backend.calls.push({ name, body });
    if (path === '/auth/v1/otp') return route.fulfill({ status: 200, headers, json: {} });
    if (path === '/auth/v1/verify') return route.fulfill({ status: 200, headers, json: session(false) });
    if (path === '/auth/v1/signup') return route.fulfill({ status: 200, headers, json: session(true) });
    const answer = path.startsWith('/rest/v1/rpc/') ? backend.answer(name, body) : null;
    if (!answer) return route.fulfill({ status: 404, headers, json: { message: 'Unexpected test request', code: 'PGRST202' } });
    return route.fulfill({ status: 200, headers, json: answer });
  });
}

async function signIn(page: Page) {
  await page.getByLabel('이메일', { exact: true }).fill('mom@example.test');
  await page.getByRole('button', { name: '인증 코드 받기' }).click();
  await page.getByLabel('인증 코드 입력', { exact: true }).fill('123456');
  await page.getByRole('button', { name: '확인', exact: true }).click();
}

test('live guardian: P-18 sends declare_no_driver, P-19 sends set_unavailable_day and P-13 sends the place note', async ({ context, page }) => {
  const backend = new Backend();
  await stub(context, backend);
  await page.goto(`${liveUrl}/p/`);
  await signIn(page);
  // get_today's no_available_driver and place note drive the nobody card.
  const now = page.getByRole('region', { name: '지금' });
  await expect(now.getByRole('heading', { name: '민준 픽업, 갈 사람이 없어요' })).toBeVisible();
  expect(backend.named('get_today').at(-1)?.body).toEqual({ p_days: 2 });
  await now.getByRole('link', { name: /민준 픽업, 갈 사람이 없어요/ }).click();
  await expect(page).toHaveURL(`${liveUrl}/p/pickups/${pickupId}`);
  await page.getByRole('button', { name: '못 간다고 알리기' }).click();
  const sheet = page.getByRole('dialog', { name: '민준에게 못 간다고 알릴까요?' });
  await expect(sheet.getByRole('radio', { name: /학원 안에서 기다리기/ })).toBeChecked();
  await sheet.getByRole('button', { name: '못 간다고 알리기' }).click();
  await expect(page.getByRole('heading', { name: '못 간다고 알림' })).toBeVisible();
  expect(backend.named('declare_no_driver').map((call) => call.body)).toEqual([{ p_pickup_id: pickupId, p_expected_version: 1, p_note: '학원 안에서 기다리기' }]);
  await expect(page.getByText('엄마가 못 간다고 알림', { exact: true })).toBeVisible();
  await expect(page.getByText('확인 전', { exact: true })).toBeVisible();

  await page.goto(`${liveUrl}/p/unavailable`);
  const cell = page.locator('.unavailable-day').first();
  await expect(cell).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.unavailable-others').first()).toHaveText('아');
  await cell.click();
  await expect(cell).toHaveAttribute('aria-pressed', 'true');
  expect(backend.named('set_unavailable_day').map((call) => call.body)).toEqual([{ p_day: seoulDay, p_unavailable: true }]);
  await cell.click();
  await expect(cell).toHaveAttribute('aria-pressed', 'false');
  expect(backend.named('set_unavailable_day').at(-1)?.body).toEqual({ p_day: seoulDay, p_unavailable: false });

  await page.goto(`${liveUrl}/p/places/${placeId}`);
  const note = page.getByRole('textbox', { name: '못 갈 때 안내 (선택)' });
  await expect(note).toHaveValue('학원 안에서 기다리기');
  await page.getByRole('button', { name: '셔틀 타기' }).click();
  await page.getByRole('button', { name: '저장' }).click();
  await expect(page).toHaveURL(`${liveUrl}/p/family`);
  expect(backend.named('upsert_place').at(-1)?.body).toEqual({ p_place_id: placeId, p_label: '수학학원', p_kind: 'academy', p_lat: 37.5001, p_lng: 127.0371,
    p_radius_m: 150, p_fallback_note: '셔틀 타기' });
  await expect(page.getByRole('link', { name: /^수학학원\s*셔틀 타기$/ })).toBeVisible();
});

test('live rider: the declaration from rider_get_state, then "알겠어" sends ack_fallback with the pickup only', async ({ context, page }) => {
  const backend = new Backend();
  backend.declared = true;
  await stub(context, backend);
  await page.goto(`${liveUrl}/c/start?code=48217730`);
  await page.getByRole('link', { name: '설치 없이 쓰기' }).click();
  await page.getByRole('button', { name: '연결하기' }).click();
  await expect(page.getByRole('heading', { name: '민준으로 연결됐어' })).toBeVisible();
  await page.getByRole('button', { name: '계속하기' }).click();
  await page.getByRole('link', { name: '나중에 할게' }).click();
  await expect(page.getByRole('heading', { name: '오늘은 데리러 못 가' })).toBeVisible();
  await expect(page.getByText('학원 안에서 기다리기')).toBeVisible();
  await expect(page.getByText('엄마가 알려줬어')).toBeVisible();
  await expect(page.getByRole('link', { name: '엄마에게 전화' })).toHaveAttribute('href', 'tel:+821012345678');
  await page.getByRole('button', { name: '알겠어' }).click();
  await expect(page.getByRole('heading', { name: '알겠다고 전했어' })).toBeVisible();
  expect(backend.named('ack_fallback').map((call) => call.body)).toEqual([{ p_pickup_id: pickupId }]);
});
