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
