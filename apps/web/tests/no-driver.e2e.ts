import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// SPEC 24 갈 사람이 없을 때 in the browser demo. Every test starts a fresh demo family on Wednesday 11월 4일 at 17:02.

async function request(rider: Page) {
  await rider.bringToFront();
  await rider.getByRole('button', { name: '수학학원', exact: true }).click();
  await rider.getByRole('button', { name: '정문', exact: true }).click();
  await rider.getByRole('button', { name: '데리러 와', exact: true }).click();
}

const nowSection = (page: Page) => page.getByRole('region', { name: '지금' });
const todayCell = (page: Page) => page.getByRole('button', { name: /^11월 4일 수요일/ });

async function viewAs(guardian: Page, member: 'mom' | 'dad' | 'aunt') {
  await guardian.goto('/p/');
  await guardian.getByRole('combobox', { name: '보는 사람' }).selectOption(member);
}

test('S-57: with both drivers off today the rider sees nobody can go with the place note, and the guardians the nobody card', async ({ context }) => {
  const guardian = await context.newPage();
  const rider = await context.newPage();
  await Promise.all([guardian.goto('/p/routines'), rider.goto('/c/')]);
  await guardian.bringToFront();
  await guardian.getByRole('link', { name: '못 가는 날' }).click();
  await expect(guardian.getByRole('heading', { name: '못 가는 날' })).toBeVisible();
  await expect(todayCell(guardian)).toHaveAttribute('aria-pressed', 'false');
  await todayCell(guardian).click();
  await expect(todayCell(guardian)).toHaveAttribute('aria-pressed', 'true');
  await viewAs(guardian, 'dad');
  await guardian.goto('/p/unavailable');
  // Mom's day shows as her initial under the cell, and in the cell's name.
  await expect(todayCell(guardian)).toHaveAccessibleName('11월 4일 수요일, 엄마 못 가는 날');
  await expect(guardian.locator('.unavailable-others').first()).toHaveText('엄');
  await todayCell(guardian).click();
  await expect(todayCell(guardian)).toHaveAttribute('aria-pressed', 'true');
  // The math routine (dad, 17:30 today) now needs a driver nobody can be.
  await expect(guardian.getByText('11/4 수 17:30 민준, 수학학원')).toBeVisible();
  await expect(guardian.getByText('갈 수 있는 사람이 없어요')).toBeVisible();

  await request(rider);
  await expect(rider.getByRole('heading', { name: '지금 갈 수 있는 사람이 없어' })).toBeVisible();
  await expect(rider.getByText('엄마, 아빠가 방법을 찾고 있어')).toBeVisible();
  await expect(rider.getByText('기다리는 동안')).toBeVisible();
  await expect(rider.getByText('학원 안에서 기다리기')).toBeVisible();
  await expect(rider.locator('.call-bar--emphasized')).toBeVisible();

  await guardian.bringToFront();
  await guardian.goto('/p/');
  await expect(nowSection(guardian).getByRole('heading', { name: '민준 픽업, 갈 사람이 없어요' })).toBeVisible();
  await expect(nowSection(guardian).getByText('모두 못 간다고 했거나 못 가는 날이에요')).toBeVisible();
  // A guardian who marked the day may still go (24.3).
  await nowSection(guardian).getByRole('button', { name: '내가 갈게' }).click();
  await guardian.getByRole('dialog').getByRole('button', { name: '내가 갈게' }).click();
  await expect(rider.getByRole('heading', { name: '아빠가 데리러 갈게' })).toBeVisible();
});

test('S-59, S-60, S-69: a guardian declares from P-18, the rider acknowledges, and the cards follow', async ({ context }) => {
  const guardian = await context.newPage();
  const rider = await context.newPage();
  await Promise.all([guardian.goto('/p/'), rider.goto('/c/')]);
  await request(rider);
  await guardian.bringToFront();
  // An ordinary request card keeps "요청 닫기"; P-05 offers "못 간다고 알리기" in its text row.
  await expect(nowSection(guardian).getByRole('button', { name: '요청 닫기' })).toBeVisible();
  await nowSection(guardian).getByRole('link', { name: /민준이 데리러 와 달래요/ }).click();
  await expect(guardian).toHaveURL(/\/p\/pickups\/[\w-]+$/);
  const detail = guardian.url();
  await guardian.getByRole('button', { name: '못 간다고 알리기' }).click();
  const sheet = guardian.getByRole('dialog', { name: '민준에게 못 간다고 알릴까요?' });
  await expect(sheet.getByRole('radio', { name: /학원 안에서 기다리기/ })).toBeChecked();
  await expect(sheet.getByText('수학학원에 정해 둔 안내')).toBeVisible();
  await sheet.getByText('직접 쓰기').click();
  await expect(sheet.getByRole('button', { name: '못 간다고 알리기' })).toBeDisabled();
  await sheet.getByRole('textbox', { name: '직접 쓰기' }).fill('편의점 앞에서 기다리기');
  await expect(sheet.getByText('12/40')).toBeVisible();
  await sheet.getByRole('radio', { name: /학원 안에서 기다리기/ }).check();
  await sheet.getByRole('button', { name: '못 간다고 알리기' }).click();
  await expect(guardian.getByRole('status')).toHaveText('민준에게 알렸어요');
  await expect(guardian.getByRole('dialog')).toHaveCount(0);
  await expect(guardian.getByRole('heading', { name: '못 간다고 알림' })).toBeVisible();

  await rider.bringToFront();
  await expect(rider.getByRole('heading', { name: '오늘은 데리러 못 가' })).toBeVisible();
  await expect(rider.getByText('대신 이렇게 해 줘')).toBeVisible();
  await expect(rider.getByText('학원 안에서 기다리기')).toBeVisible();
  await expect(rider.getByText('엄마가 알려줬어')).toBeVisible();
  await expect(rider.locator('.call-bar--emphasized')).toHaveCount(0);

  await guardian.bringToFront();
  await guardian.goto('/p/');
  await expect(nowSection(guardian).getByRole('heading', { name: '민준에게 못 간다고 알렸어요' })).toBeVisible();
  await expect(nowSection(guardian).getByText('민준 확인 전')).toBeVisible();
  // Five minutes without "알겠어": the guardian card turns urgent and the rider's call buttons grow.
  const tools = await context.newPage();
  await tools.goto('/p/demo');
  await tools.getByLabel('시각 앞당기기').selectOption('5');
  await tools.getByRole('button', { name: '지금 실행' }).click();
  await guardian.bringToFront();
  await expect(nowSection(guardian).getByRole('heading', { name: '민준이 아직 확인하지 않았어요' })).toBeVisible();
  await rider.bringToFront();
  await expect(rider.locator('.call-bar--emphasized')).toBeVisible();

  await rider.getByRole('button', { name: '알겠어' }).click();
  await expect(rider.getByRole('heading', { name: '알겠다고 전했어' })).toBeVisible();
  await guardian.bringToFront();
  await expect(nowSection(guardian).getByRole('heading', { name: '민준이 확인했어요' })).toBeVisible();
  await nowSection(guardian).getByRole('button', { name: '확인' }).click();
  await expect(nowSection(guardian).getByRole('heading', { name: '민준이 확인했어요' })).toHaveCount(0);

  await guardian.goto(detail);
  await expect(guardian.getByText('대신 할 일', { exact: true })).toBeVisible();
  await expect(guardian.getByText(/^확인 \d{2}:\d{2}$/)).toBeVisible();
  await expect(guardian.getByText('엄마가 못 간다고 알림', { exact: true })).toBeVisible();
  await expect(guardian.getByText('민준이 확인', { exact: true })).toBeVisible();

  // S-69: the rider asks again and the new request replaces the declaration.
  await rider.bringToFront();
  await rider.getByRole('button', { name: '다시 요청' }).click();
  await request(rider);
  await expect(rider.getByRole('heading', { name: '데리러 와 달라고 보냈어' })).toBeVisible();
});

test('S-65, S-66: dad marks today off on P-19, his routine occurrence opens; clearing the day gives it back', async ({ context }) => {
  const guardian = await context.newPage();
  const tools = await context.newPage();
  await tools.goto('/p/demo');
  await tools.getByRole('button', { name: '오늘 루틴 픽업 불러오기' }).click();
  await expect(tools.getByRole('status')).toHaveText('오늘 루틴 픽업을 불러왔어요.');
  await guardian.bringToFront();
  await viewAs(guardian, 'dad');
  const occurrence = guardian.locator('.guardian-timeline-row', { hasText: '민준, 수학학원' });
  await expect(occurrence).toContainText('담당 아빠');

  await guardian.getByRole('link', { name: '루틴', exact: true }).click();
  await guardian.getByRole('link', { name: '못 가는 날' }).click();
  await todayCell(guardian).click();
  await expect(todayCell(guardian)).toHaveAttribute('aria-pressed', 'true');
  // The occurrence is made, so the row leads to the pickup.
  await expect(guardian.getByRole('link', { name: /11\/4 수 17:30 민준, 수학학원/ })).toBeVisible();
  await expect(guardian.getByText('기본 담당 아빠가 못 가는 날')).toBeVisible();
  await guardian.getByRole('link', { name: '돌아가기' }).click();
  await expect(guardian.getByText('이번엔 담당 없음')).toBeVisible();
  await guardian.goto('/p/');
  await expect(occurrence).toContainText('답 기다리는 중');

  await guardian.goto('/p/unavailable');
  await todayCell(guardian).click();
  await expect(todayCell(guardian)).toHaveAttribute('aria-pressed', 'false');
  await expect(guardian.getByText('갈 사람을 정해야 하는 픽업')).toHaveCount(0);
  await guardian.goto('/p/');
  await expect(occurrence).toContainText('담당 아빠');
});

test('P-19 tells a guardian the trip they hold that day stays theirs; a guardian who cannot drive has nothing to mark', async ({ context }) => {
  const guardian = await context.newPage();
  const rider = await context.newPage();
  await Promise.all([guardian.goto('/p/'), rider.goto('/c/')]);
  await request(rider);
  await guardian.bringToFront();
  await nowSection(guardian).getByRole('button', { name: '내가 갈게' }).click();
  await guardian.getByRole('dialog').getByRole('button', { name: '내가 갈게' }).click();
  await expect(rider.getByRole('heading', { name: '엄마가 데리러 갈게' })).toBeVisible();
  await guardian.goto('/p/unavailable');
  await todayCell(guardian).click();
  await expect(guardian.getByText('이날 맡은 픽업 1건은 그대로예요. 필요하면 넘겨 주세요.')).toBeVisible();
  await expect(rider.getByRole('heading', { name: '엄마가 데리러 갈게' })).toBeVisible();
  await viewAs(guardian, 'aunt');
  await guardian.goto('/p/unavailable');
  await expect(guardian.getByText('운전하지 않는 가족은 표시하지 않아도 돼요')).toBeVisible();
  await expect(todayCell(guardian)).toBeDisabled();
});

test('P-13 saves a place note from a preset chip; P-10 shows it and a blank note clears it', async ({ page }) => {
  await page.goto('/p/places/school');
  const note = page.getByRole('textbox', { name: '못 갈 때 안내 (선택)' });
  await expect(note).toHaveValue('');
  await page.getByRole('button', { name: '셔틀 타기' }).click();
  await expect(note).toHaveValue('셔틀 타기');
  await expect(page.getByRole('button', { name: '셔틀 타기' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('5/40')).toBeVisible();
  await expect(page.getByText('아무도 못 갈 때 부르는 사람 화면에 보여 줘요.')).toBeVisible();
  await page.getByRole('button', { name: '저장' }).click();
  await expect(page).toHaveURL(/\/p\/family$/);
  await expect(page.getByRole('link', { name: /^학교\s*셔틀 타기$/ })).toBeVisible();
  await page.goto('/p/places/school');
  await expect(note).toHaveValue('셔틀 타기');
  await note.fill('   ');
  await page.getByRole('button', { name: '저장' }).click();
  await expect(page.getByRole('link', { name: '학교', exact: true })).toBeVisible();
});
