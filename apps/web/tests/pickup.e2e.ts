import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function chooseSavedPoint(page: Page) {
  await page.bringToFront();
  await page.getByRole('button', { name: '수학학원', exact: true }).click();
  await page.getByRole('button', { name: '정문', exact: true }).click();
}

test('pickup stays synchronized across rider, guardian, and vehicle', async ({ context }) => {
  const rider = await context.newPage();
  const guardian = await context.newPage();
  const vehicle = await context.newPage();
  await Promise.all([rider.goto('/c/'), guardian.goto('/p/'), vehicle.goto('/v/')]);
  await chooseSavedPoint(rider);
  await rider.getByRole('button', { name: '후문 주차장' }).click();
  await rider.getByRole('button', { name: '데리러 와', exact: true }).click();
  await expect(rider.getByRole('heading', { name: '데리러 와 달라고 보냈어' })).toBeVisible();
  await expect(guardian.getByRole('heading', { name: '민준이 데리러 와 달래요' })).toBeVisible();
  await expect(vehicle.getByText('수학학원, 후문 주차장, 후문 벤치 앞')).toBeVisible();
  await guardian.getByRole('button', { name: '내가 갈게' }).click();
  await guardian.getByRole('dialog').getByRole('button', { name: '내가 갈게' }).click();
  await expect(rider.getByRole('heading', { name: '엄마가 데리러 갈게' })).toBeVisible();
  await guardian.getByRole('button', { name: '넘기기' }).click();
  await guardian.getByRole('button', { name: '아빠에게 부탁하기' }).click();
  await expect(rider.getByRole('heading', { name: '엄마가 데리러 갈게' })).toBeVisible();
  await guardian.getByRole('combobox', { name: '보는 사람' }).selectOption('dad');
  await guardian.getByRole('button', { name: '수락' }).click();
  await guardian.getByRole('dialog').getByRole('button', { name: '내가 갈게' }).click();
  await expect(rider.getByRole('heading', { name: '아빠가 데리러 갈게' })).toBeVisible();
  await vehicle.getByRole('button', { name: '출발하고 안내' }).click();
  await expect(rider.getByRole('heading', { name: '아빠가 출발했어' })).toBeVisible();
  await vehicle.getByRole('button', { name: '도착했어요' }).click();
  await expect(rider.getByRole('heading', { name: '아빠가 도착했어' })).toBeVisible();
  await rider.getByRole('button', { name: '탔어' }).click();
  await expect(vehicle.getByRole('heading', { name: '탑승 확인됨' })).toBeVisible();
  await guardian.reload();
  await expect(guardian.getByText('탑승 확인', { exact: true })).toBeVisible();
});

test('mobile keyboard selects a demo map pin and request cancellation syncs', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/c/');
  await page.getByRole('button', { name: '지도에서', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('group', { name: /예시 지도/ }).press('ArrowRight');
  await dialog.getByRole('button', { name: '편의점 앞' }).click();
  await dialog.getByRole('button', { name: '여기로 할게' }).click();
  await page.getByRole('button', { name: '데리러 와', exact: true }).click();
  await expect(page.getByRole('heading', { name: '데리러 와 달라고 보냈어' })).toBeVisible();
  const guardian = await context.newPage();
  await guardian.goto('/p/');
  await expect(guardian.getByText('역삼동 근처, 편의점 앞')).toBeVisible();
  await page.getByRole('button', { name: '요청 취소' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '요청 취소' }).click();
  await page.getByRole('button', { name: '취소할게' }).click();
  await expect(guardian.getByText('취소', { exact: true })).toBeVisible();
});

test('sender can depart while a handoff is pending', async ({ context }) => {
  const rider = await context.newPage();
  const guardian = await context.newPage();
  await Promise.all([rider.goto('/c/'), guardian.goto('/p/')]);
  await chooseSavedPoint(rider);
  await rider.getByRole('button', { name: '데리러 와', exact: true }).click();
  await guardian.getByRole('button', { name: '내가 갈게' }).click();
  await guardian.getByRole('dialog').getByRole('button', { name: '내가 갈게' }).click();
  await guardian.getByRole('button', { name: '넘기기' }).click();
  await guardian.getByRole('button', { name: '아빠에게 부탁하기' }).click();
  await expect(guardian.getByText('수락하기 전까지는 내가 담당이에요.')).toBeVisible();
  await guardian.getByRole('button', { name: '출발했어요' }).click();
  await expect(rider.getByRole('heading', { name: '엄마가 출발했어' })).toBeVisible();
  await guardian.getByRole('combobox', { name: '보는 사람' }).selectOption('dad');
  await expect(guardian.getByRole('button', { name: '수락' })).toHaveCount(0);
});

async function handOffToDad(context: import('@playwright/test').BrowserContext) {
  const rider = await context.newPage();
  const guardian = await context.newPage();
  const vehicle = await context.newPage();
  await Promise.all([rider.goto('/c/'), guardian.goto('/p/'), vehicle.goto('/v/')]);
  await chooseSavedPoint(rider);
  await rider.getByRole('button', { name: '데리러 와', exact: true }).click();
  await guardian.bringToFront();
  await guardian.getByRole('button', { name: '내가 갈게' }).click();
  await guardian.getByRole('dialog').getByRole('button', { name: '내가 갈게' }).click();
  await guardian.getByRole('button', { name: '넘기기' }).click();
  await guardian.getByRole('button', { name: '야근이야' }).click();
  await guardian.getByRole('button', { name: '아빠에게 부탁하기' }).click();
  await vehicle.bringToFront();
  await expect(vehicle.getByRole('heading', { name: '엄마가 부탁했어요' })).toBeVisible();
  await expect(vehicle.getByText('“야근이야”')).toBeVisible();
  return { rider, guardian, vehicle };
}

test('vehicle answers a handoff with accept from the V-03 card', async ({ context }) => {
  const { rider, vehicle } = await handOffToDad(context);
  await vehicle.getByRole('button', { name: '수락', exact: true }).click();
  await expect(rider.getByRole('heading', { name: '아빠가 데리러 갈게' })).toBeVisible();
  await expect(vehicle.getByRole('button', { name: '출발하고 안내' })).toBeVisible();
});

test('vehicle decline keeps the sender assigned and closes the card', async ({ context }) => {
  const { rider, vehicle } = await handOffToDad(context);
  await vehicle.getByRole('button', { name: '거절', exact: true }).click();
  await expect(vehicle.getByRole('status')).toHaveText('엄마에게 알렸어요');
  await expect(vehicle.getByRole('heading', { name: '엄마가 부탁했어요' })).toHaveCount(0);
  await expect(rider.getByRole('heading', { name: '엄마가 데리러 갈게' })).toBeVisible();
});

test('"못 가요" on a request closes it on this car only', async ({ context }) => {
  const rider = await context.newPage();
  const guardian = await context.newPage();
  const vehicle = await context.newPage();
  await Promise.all([rider.goto('/c/'), guardian.goto('/p/'), vehicle.goto('/v/')]);
  await chooseSavedPoint(rider);
  await rider.getByRole('button', { name: '데리러 와', exact: true }).click();
  await vehicle.bringToFront();
  await expect(vehicle.getByRole('heading', { name: '민준이 데리러 와 달래요' })).toBeVisible();
  await vehicle.getByRole('button', { name: '못 가요' }).click();
  await expect(vehicle.getByRole('status')).toHaveText('다른 가족에게 알렸어요');
  await expect(vehicle.getByRole('heading', { name: '민준이 데리러 와 달래요' })).toHaveCount(0);
  await vehicle.reload();
  await expect(vehicle.getByRole('heading', { name: '민준이 데리러 와 달래요' })).toHaveCount(0);
  await guardian.bringToFront();
  await expect(guardian.getByRole('heading', { name: '민준이 데리러 와 달래요' })).toBeVisible();
});

test('a trip cancelled while driving shows its card before other cards', async ({ context }) => {
  const rider = await context.newPage();
  const vehicle = await context.newPage();
  const tools = await context.newPage();
  await Promise.all([rider.goto('/c/'), vehicle.goto('/v/'), tools.goto('/p/demo')]);
  await chooseSavedPoint(rider);
  await rider.getByRole('button', { name: '데리러 와', exact: true }).click();
  await vehicle.bringToFront();
  await vehicle.getByRole('button', { name: '출발하고 안내' }).click();
  await tools.bringToFront();
  await tools.getByRole('button', { name: '지금 실행' }).click();
  await rider.bringToFront();
  await rider.getByRole('button', { name: '요청 취소' }).click();
  await rider.getByRole('dialog').getByRole('button', { name: '취소할게' }).click();
  await vehicle.bringToFront();
  await expect(vehicle.getByRole('heading', { name: '민준 픽업이 취소됐어요' })).toBeVisible();
  await vehicle.getByRole('button', { name: '확인' }).click();
  await expect(vehicle.getByRole('heading', { name: '곧 출발할 시간이에요' })).toBeVisible();
});

test('car unpairs from V-09, shows V-01, and pairs again only with the code on the car', async ({ context }) => {
  const vehicle = await context.newPage();
  const guardian = await context.newPage();
  await Promise.all([vehicle.goto('/v/'), guardian.goto('/p/family')]);
  await vehicle.bringToFront();
  await vehicle.getByRole('button', { name: '설정' }).click();
  await expect(vehicle.getByRole('heading', { name: '지금 운전하는 사람' })).toBeVisible();
  await vehicle.getByRole('button', { name: '연결 해제' }).click();
  await expect(vehicle.getByRole('heading', { name: '이 차의 연결을 해제할까요?' })).toBeVisible();
  await vehicle.getByRole('button', { name: '연결 해제' }).click();
  await expect(vehicle.getByRole('status')).toHaveText('차 연결을 해제했어요.');
  await expect(vehicle.getByRole('heading', { name: '가족 휴대폰으로 연결해요' })).toBeVisible();
  const code = (await vehicle.locator('.vehicle-pair-code strong').textContent())!.replace('-', '');
  expect(code).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);
  await expect(vehicle.getByRole('img', { name: '데모 QR 코드' })).toBeVisible();
  // The family list no longer shows the disconnected car.
  await guardian.bringToFront();
  await expect(guardian.getByRole('link', { name: /우리 차/ })).toHaveCount(0);
  // A wrong code is rejected and nothing changes.
  await guardian.goto('/p/vehicles/pair');
  await guardian.getByLabel('차 화면의 코드 6자리').fill(code === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA');
  await guardian.getByRole('button', { name: '엄마' }).click();
  await guardian.getByRole('button', { name: '연결하기' }).click();
  await expect(guardian.getByRole('alert')).toHaveText('차 화면의 코드와 달라요. 다시 확인해 주세요.');
  // The QR link carries the code; the guardian names the car and picks who drives.
  await guardian.goto(`/p/vehicles/pair?code=${code}`);
  await expect(guardian.getByText(`${code.slice(0, 3)}-${code.slice(3)}`)).toBeVisible();
  await guardian.getByLabel('차 이름').fill('엄마 차');
  await guardian.getByRole('button', { name: '엄마' }).click();
  await guardian.getByRole('button', { name: '연결하기' }).click();
  await expect(guardian.getByRole('heading', { name: '엄마 차' })).toBeVisible();
  await vehicle.bringToFront();
  await expect(vehicle.getByRole('heading', { name: '가족 휴대폰으로 연결해요' })).toHaveCount(0);
  await expect(vehicle.getByText('운전자 엄마')).toBeVisible();
  // Pairing a car that is already connected is refused.
  await guardian.goto(`/p/vehicles/pair?code=${code}`);
  await expect(guardian.getByRole('heading', { name: '엄마 차가 이미 연결돼 있어요' })).toBeVisible();
});

test('changing the driver on V-09 moves the cards to the new driver', async ({ context }) => {
  const rider = await context.newPage();
  const guardian = await context.newPage();
  const vehicle = await context.newPage();
  await Promise.all([rider.goto('/c/'), guardian.goto('/p/'), vehicle.goto('/v/')]);
  await chooseSavedPoint(rider);
  await rider.getByRole('button', { name: '데리러 와', exact: true }).click();
  await guardian.bringToFront();
  await guardian.getByRole('button', { name: '내가 갈게' }).click();
  await guardian.getByRole('dialog').getByRole('button', { name: '내가 갈게' }).click();
  await vehicle.bringToFront();
  // The car belongs to dad, so mom's pickup is not on it.
  await expect(vehicle.getByRole('button', { name: '출발하고 안내' })).toHaveCount(0);
  await vehicle.getByRole('button', { name: '설정' }).click();
  await vehicle.getByRole('button', { name: '엄마' }).click();
  await expect(vehicle.getByRole('status')).toHaveText('운전자를 엄마로 바꿨어요.');
  await expect(vehicle.getByRole('button', { name: '엄마' })).toHaveAttribute('aria-pressed', 'true');
  await vehicle.getByRole('button', { name: '돌아가기' }).click();
  await expect(vehicle.getByText('운전자 엄마')).toBeVisible();
  // Mom accepted without a car, so her pickup now shows on the car she is driving.
  await expect(vehicle.getByRole('button', { name: '출발하고 안내' })).toBeVisible();
  await guardian.bringToFront();
  await guardian.goto('/p/family');
  await expect(guardian.getByText('운전자 엄마')).toBeVisible();
});

test('repeated cancelled requests return the rider to a fresh form', async ({ page }) => {
  await page.goto('/c/');
  for (let repeat = 0; repeat < 2; repeat++) {
    await chooseSavedPoint(page);
    await page.getByRole('button', { name: '데리러 와', exact: true }).click();
    await page.getByRole('button', { name: '요청 취소' }).click();
    await page.getByRole('dialog').getByRole('button', { name: '취소할게' }).click();
    await page.getByRole('button', { name: '다시 데리러 와' }).click();
    await expect(page.getByRole('group', { name: '어디야?' })).toBeVisible();
  }
});

test('vehicle may record arrival in driving mode and waits for parked boarding', async ({ context }) => {
  const rider = await context.newPage();
  const vehicle = await context.newPage();
  await Promise.all([rider.goto('/c/'), vehicle.goto('/v/')]);
  await chooseSavedPoint(rider);
  await rider.getByRole('button', { name: '데리러 와', exact: true }).click();
  await vehicle.getByRole('button', { name: '출발하고 안내' }).click();
  await vehicle.getByRole('button', { name: '데모 도구' }).click();
  await vehicle.getByRole('button', { name: '주행 중' }).click();
  await vehicle.getByRole('button', { name: '도착했어요' }).click();
  await expect(vehicle.getByRole('button', { name: '태웠어요' })).toBeDisabled();
  await vehicle.getByRole('button', { name: '주차 중' }).click();
  await vehicle.getByRole('button', { name: '태웠어요' }).click();
  await expect(rider.getByRole('heading', { name: '만났어!' })).toBeVisible();
});
