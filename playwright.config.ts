import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config — boots a SvelteKit dev server with a sealed test
 * environment (its own DB, media dir, config.toml, AUTH_SECRET) so the
 * suite can't disturb anyone's real `data/`. global-setup.ts inserts a
 * test user + session and writes a storage-state file containing the
 * session cookie; every test starts already-authenticated.
 */
export default defineConfig({
	testDir: './tests/e2e',
	fullyParallel: false,
	workers: 1,
	timeout: 30_000,
	reporter: process.env.CI ? 'github' : 'list',
	use: {
		baseURL: 'http://localhost:5173',
		storageState: './tests/.e2e-data/auth.json',
		trace: 'on-first-retry'
	},
	globalSetup: './tests/e2e/global-setup.ts',
	projects: [
		{
			name: 'chromium-desktop',
			use: { ...devices['Desktop Chrome'] }
		},
		{
			name: 'chromium-mobile',
			use: { ...devices['Pixel 5'] }
		}
	],
	webServer: {
		command: 'pnpm dev',
		url: 'http://localhost:5173/api/health',
		reuseExistingServer: !process.env.CI,
		timeout: 60_000,
		env: {
			DB_PATH: './tests/.e2e-data/test.db',
			MEDIA_DIR: './tests/.e2e-data/media',
			MEDIA_GRACE_PERIOD_DAYS: '7',
			MEDIA_PURGE_INTERVAL_SECONDS: '3600',
			AUTH_SECRET: 'e2e-test-secret-not-used-in-prod-32chars',
			GITHUB_OAUTH_CLIENT_ID: 'e2e-stub',
			GITHUB_OAUTH_CLIENT_SECRET: 'e2e-stub',
			ALLOWED_GITHUB_USER_IDS: '99999',
			PUBLIC_BASE_URL: 'http://localhost:5173',
			CONFIG_PATH: './tests/e2e/fixtures/config.toml',
			LOG_LEVEL: 'warn'
		}
	}
});
