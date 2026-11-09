import { expect, test } from '@playwright/test';
import type { BrowserContext } from '@playwright/test';

const liveUrl = 'http://127.0.0.1:5176';
const familyId = '10000000-0000-4000-8000-000000000001';
const guardianId = '10000000-0000-4000-8000-000000000002';
const riderId = '10000000-0000-4000-8000-000000000003';
const placeId = '10000000-0000-4000-8000-000000000004';
const pickupId = '10000000-0000-4000-8000-000000000005';
const now = new Date().toISOString();
const member = { id: guardianId, family_id: familyId, display_name: '엄마', role: 'owner', can_drive: true, can_request: true, location_consented_at: now };
const rider = { id: riderId, family_id: familyId, display_name: '할머니', kind: 'adult', consent_basis: 'self' };
const place = { id: placeId, family_id: familyId, label: '도서관', kind: 'other', lat: 37.501, lng: 127.031, radius_m: 150 };
const dataPickup = { id: pickupId, family_id: familyId, rider_id: riderId, rider_member_id: null, assignee_member_id: guardianId, status: 'assigned', source: 'request',
  dest_lat: place.lat, dest_lng: place.lng, dest_label: place.label, location_source: 'saved_place', location_confirmed: true, place_id: placeId, wanted_at: now,
  created_at: now, accepted_at: now, version: 2, assignment_round: 1, destination_revision: 1 };
const family = { id: familyId, name: '우리 가족', timezone: 'Asia/Seoul' };

function session(isAnonymous: boolean) {
  const id = isAnonymous ? '10000000-0000-4000-8000-000000000007' : '10000000-0000-4000-8000-000000000006';
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const user = { id, role: 'authenticated', aud: 'authenticated', email: isAnonymous ? '' : 'guard@example.test', app_metadata: {}, user_metadata: {}, created_at: now, is_anonymous: isAnonymous };
  return { user, access_token: `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: id, exp: Math.floor(Date.now() / 1000) + 3600, is_anonymous: isAnonymous, role: 'authenticated' })}.signature`, refresh_token: `refresh-${id}`, expires_in: 3600, token_type: 'bearer' };
}

type RecordCall = { name: string; body: Record<string, unknown>; token: string | undefined };
async function stubApi(context: BrowserContext, initialFamily = true) {
  let hasFamily = initialFamily;
  let paired = false;
  let requested = false;
  const calls: RecordCall[] = [];
  await context.route('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit', (route) => route.fulfill({
    contentType: 'application/javascript', body: `window.turnstile = {render(el, options) { setTimeout(() => options.callback('test-captcha-token'), 0); return 'test-widget'; }, remove() {}};`,
  }));
  await context.route('http://127.0.0.1:56789/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, GET, OPTIONS' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const body = request.postDataJSON() as Record<string, unknown> ?? {};
    const name = path.split('/').at(-1)!;
    const token = request.headers().authorization;
    calls.push({ name, body, token });
    const send = (json: unknown, status = 200) => route.fulfill({ status, headers, json });
    const ok = (value: object) => send({ ok: true, data: value });
    const fail = (code: string) => send({ ok: false, error: { code, detail: {} } });
    if (path === '/auth/v1/otp') return send({});
    if (path === '/auth/v1/verify') return send(session(false));
    if (path === '/auth/v1/signup') return send(session(true));
    if (path === '/auth/v1/authorize') {
      const query = new URL(request.url()).searchParams;
      calls.push({ name: 'oauth-options', body: Object.fromEntries(query), token });
      return route.fulfill({ status: 302, headers: { ...headers, location: `${liveUrl}/p/auth/callback?code=test-auth-code` } });
    }
    if (path === '/auth/v1/token' && new URL(request.url()).searchParams.get('grant_type') === 'pkce') return send(session(false));
    if (name === 'get_family_overview') return hasFamily ? ok({ family, me: member, members: [member], riders: [rider], rider_devices: [], vehicles: [], places: [place], pickup_points: [], routines: [] }) : fail('NOT_GUARDIAN');
    if (name === 'create_family') { hasFamily = true; return ok({ family, member }); }
    if (name === 'preview_family_invite') return ok({ family_name: family.name, inviter_name: '아빠' });
    if (name === 'join_family') { hasFamily = true; return ok({ family, member }); }
    if (name === 'get_pickup') return ok({ pickup: dataPickup, offers: [], events: [{ event_type: 'created', pickup_id: pickupId, created_at: now }], assignee: member, vehicle: null, required_km: null });
    if (name === 'get_today') return ok({ active: [dataPickup], timeline: [], pending_offers_to_me: [], alerts: [], server_time: new Date().toISOString() });
    if (name === 'claim_rider_invite') {
      if (!body.p_consent) return fail('CONSENT_REQUIRED');
      paired = true;
      return ok({ rider, device_id: '10000000-0000-4000-8000-000000000008' });
    }
    if (name === 'rider_create_request') { requested = true; return ok({ pickup: dataPickup }); }
    if (name === 'rider_get_state') return paired ? ok({ rider, callable_guardians: [{ id: guardianId, display_name: '엄마', phone_e164: '+821012345678' }], places: [place], pickup_points: [],
      actives: requested ? [{ ...dataPickup, status: 'open', version: 1, assignee_member_id: null, dest_lat: undefined, dest_lng: undefined }] : [], today: [], server_time: new Date().toISOString() }) : fail('NOT_RIDER_DEVICE');
    return send({ message: 'Unexpected test RPC', code: 'PGRST202' }, 404);
  });
  return calls;
}

async function signIn(page: import('@playwright/test').Page) {
  await page.getByLabel('이메일', { exact: true }).fill('guard@example.test');
  await page.getByRole('button', { name: '인증 코드 받기' }).click();
  await page.getByLabel('인증 코드 입력', { exact: true }).fill('123456');
  await page.getByRole('button', { name: '확인', exact: true }).click();
}

test('live guardian email OTP returns to a pickup deep link', async ({ context, page }) => {
  const calls = await stubApi(context);
  await page.goto(`${liveUrl}/p/pickups/${pickupId}`);
  await expect(page).toHaveURL(`${liveUrl}/p/login`);
  await signIn(page);
  await expect(page).toHaveURL(`${liveUrl}/p/pickups/${pickupId}`);
  await expect(page.getByRole('heading', { name: /할머니/ })).toBeVisible();
  await expect(page.getByRole('img', { name: '지도를 표시할 수 없어요.' })).toBeVisible();
  expect(calls.find((call) => call.name === 'verify')?.body).toMatchObject({ email: 'guard@example.test', token: '123456', type: 'email' });
  expect(calls.find((call) => call.name === 'get_pickup')?.body).toEqual({ p_pickup_id: pickupId });
  expect(calls.find((call) => call.name === 'otp')?.body.gotrue_meta_security).toEqual({ captcha_token: 'test-captcha-token' });
  expect(await page.evaluate(() => Boolean(localStorage.getItem('deriro-parent-auth')))).toBe(true);
  expect(await page.evaluate(() => localStorage.getItem('deriro-child-auth'))).toBe(null);
});

test('live rider invite is consumed only after explicit entry and adult consent', async ({ context, page }) => {
  const calls = await stubApi(context);
  await page.goto(`${liveUrl}/c/start?code=48217730`);
  await expect(page.getByText('4821 7730')).toBeVisible();
  expect(calls.some((call) => call.name === 'signup' || call.name === 'claim_rider_invite')).toBe(false);
  await page.getByRole('link', { name: '설치 없이 쓰기' }).click();
  await page.getByRole('button', { name: '연결하기' }).click();
  await page.getByRole('checkbox', { name: '요청할 때 위치를 가족에게 보내는 데 동의해요.' }).check();
  await page.getByRole('button', { name: '연결하기' }).click();
  await expect(page.getByRole('heading', { name: '할머니로 연결됐어' })).toBeVisible();
  await page.getByRole('button', { name: '계속하기' }).click();
  await expect(page.getByRole('heading', { name: '데리러 와를 누를 때만 위치를 가족과 공유해.' })).toBeVisible();
  await page.getByRole('link', { name: '나중에 할게' }).click();
  await expect(page.getByRole('heading', { name: '할머니' })).toBeVisible();
  await expect(page.getByRole('link', { name: '엄마에게 전화' })).toHaveAttribute('href', 'tel:+821012345678');
  await expect(page.getByRole('button', { name: '어디인지 골라줘' })).toBeDisabled();
  await page.getByRole('button', { name: '도서관', exact: true }).click();
  await page.getByRole('button', { name: '데리러 와', exact: true }).click();
  await expect(page.getByRole('heading', { name: '데리러 와 달라고 보냈어' })).toBeVisible();
  expect(calls.filter((call) => call.name === 'claim_rider_invite')).toHaveLength(2);
  expect(calls.find((call) => call.name === 'signup')?.body.gotrue_meta_security).toEqual({ captcha_token: 'test-captcha-token' });
  expect(calls.filter((call) => call.name === 'claim_rider_invite').at(-1)?.body.p_consent).toBe('2026-11-04');
  expect(calls.find((call) => call.name === 'rider_create_request')?.body).toEqual({ p_wanted_in_min: 0, p_place_id: placeId });
  expect(await page.evaluate(() => Boolean(localStorage.getItem('deriro-child-auth')))).toBe(true);
  expect(await page.evaluate(() => localStorage.getItem('deriro-parent-auth'))).toBe(null);
});

test('opt-in Kakao login exchanges a PKCE code and restores the guardian route', async ({ context, page }) => {
  const calls = await stubApi(context);
  await page.goto(`${liveUrl}/p/pickups/${pickupId}`);
  await page.getByRole('button', { name: '카카오로 시작하기' }).click();
  await expect(page.getByRole('heading', { name: /할머니/ })).toBeVisible();
  await expect(page).toHaveURL(`${liveUrl}/p/pickups/${pickupId}`);
  expect(calls.find((call) => call.name === 'oauth-options')?.body).toMatchObject({ provider: 'kakao', redirect_to: `${liveUrl}/p/auth/callback`, code_challenge_method: 's256' });
  expect(calls.find((call) => call.name === 'token')?.body).toMatchObject({ auth_code: 'test-auth-code', code_verifier: expect.any(String) });
});

test('live guardian family onboarding sends consent and E.164 without demo state', async ({ context, page }) => {
  const calls = await stubApi(context, false);
  await page.goto(`${liveUrl}/p/`);
  await signIn(page);
  await page.getByRole('button', { name: '새 가족 만들기' }).click();
  await page.getByLabel('가족이 부르는 호칭', { exact: true }).fill('엄마');
  await page.getByLabel('휴대폰 번호 (선택)', { exact: true }).fill('010-1234-5678');
  await page.getByRole('checkbox', { name: '개인정보 처리방침에 동의해요.' }).check();
  await page.getByRole('button', { name: '새 가족 만들기' }).click();
  await expect(page.getByRole('heading', { name: '알림을 켜 주세요' })).toBeVisible();
  expect(calls.find((call) => call.name === 'create_family')?.body).toEqual({ p_display_name: '엄마', p_phone_e164: '+821012345678', p_sms_opt_in: false, p_privacy_version: '2026-11-04', p_location_consent: false });
  expect(await page.evaluate(() => localStorage.getItem('deriro:local-demo:v1'))).toBe(null);
});

test('guardian invitation survives login and previews without consuming the code', async ({ context, page }) => {
  const calls = await stubApi(context, false);
  await page.goto(`${liveUrl}/p/join?code=ABCD-2345`);
  await signIn(page);
  await expect(page.getByText('아빠가 데리러 가족에 초대했어요.')).toBeVisible();
  expect(calls.find((call) => call.name === 'preview_family_invite')?.body).toEqual({ p_code: 'ABCD2345' });
  expect(calls.some((call) => call.name === 'join_family')).toBe(false);
  await page.getByLabel('가족이 부르는 호칭', { exact: true }).fill('엄마');
  await page.getByRole('checkbox', { name: '개인정보 처리방침에 동의해요.' }).check();
  await page.getByRole('button', { name: '가족 참여하기' }).click();
  await expect(page.getByRole('heading', { name: '알림을 켜 주세요' })).toBeVisible();
  expect(calls.find((call) => call.name === 'join_family')?.body.p_code).toBe('ABCD2345');
});
