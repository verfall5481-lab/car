import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  testMatch: '**/*.e2e.ts',
  expect: { timeout: 10_000 },
  use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:5174' },
  webServer: [
    { command: 'pnpm dev --port 5174 --strictPort', url: 'http://127.0.0.1:5174/p/', reuseExistingServer: false },
    { command: 'pnpm dev --port 5176 --strictPort', url: 'http://127.0.0.1:5176/p/', reuseExistingServer: false,
      env: { VITE_APP_MODE: 'live', VITE_SUPABASE_URL: 'http://127.0.0.1:56789', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_browser_test', VITE_ENABLE_KAKAO_LOGIN: 'true', VITE_TURNSTILE_SITE_KEY: 'test-turnstile-site-key' } },
  ],
});
