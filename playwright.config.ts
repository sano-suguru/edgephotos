import { defineConfig, devices } from '@playwright/test'

// Real-browser checks for what the workerd tests cannot see: canvas derivatives, file input, the share
// page, Base UI keyboard/focus behaviour and mobile layout. Server behaviour is covered by `pnpm test`.
// Runs `vite dev` (emulated Access + local presigned URLs, docs/decisions.md D-016) against a fresh
// local D1/R2 under .wrangler/e2e, so it never touches the regular dev state or any remote resource.

const STATE_DIR = '.wrangler/e2e'

export default defineConfig({
  testDir: 'e2e',
  // One dev server and one library: keep tests serial so upload counts and share state stay predictable.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 60_000,
  use: {
    // APP_ORIGIN is fixed to this origin in dev; any other host fails the Origin check on writes.
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: /mobile\.spec/ },
    // WebKit is where canvas JPEGs gained EXIF/IPTC segments (D-020); it also stands in for iPhone Safari layout.
    { name: 'mobile-webkit', use: { ...devices['iPhone 13'] }, testMatch: /(upload|mobile|timeline)\.spec/ },
  ],
  webServer: {
    command: `rm -rf ${STATE_DIR} && wrangler d1 migrations apply DB --local --persist-to ${STATE_DIR} && vite dev`,
    url: 'http://localhost:5173',
    env: { EDGEPHOTOS_STATE_DIR: STATE_DIR },
    // Never reuse a running `pnpm dev`: it would point at the developer's own local library.
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
