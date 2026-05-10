import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config — boots a production build of GlyphStream against a
 * sealed test environment (its own DB, media dir, config.toml,
 * AUTH_SECRET) so the suite can't disturb anyone's real `data/`.
 * global-setup.ts inserts a test user + session and writes a
 * storage-state file containing the session cookie; every test starts
 * already-authenticated.
 *
 * Why the production build (`node build/index.js`) instead of `pnpm dev`:
 * Vite's dev mode does lazy compilation — routes compile on first hit —
 * which races with parallel-loaded layout/page server-side load functions
 * during the very first request to a route. The first test against a
 * cold dev server can see a 500 where production correctly serves a 302.
 * The compiled handler has no such race; every route is ready
 * immediately. Costs ~10-15s for the build the first time around.
 */
export default defineConfig({
	testDir: './tests/e2e',
	fullyParallel: false,
	workers: 1,
	timeout: 30_000,
	reporter: process.env.CI ? 'github' : 'list',
	use: {
		baseURL: 'http://localhost:3000',
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
		// Build then run the compiled adapter-node handler. `&&` chained
		// so we fail fast if the build breaks.
		command: 'pnpm build && node build/index.js',
		url: 'http://localhost:3000/api/health',
		reuseExistingServer: !process.env.CI,
		// Build can take 10-15s on a cold cache, then the server boots in <1s.
		// 120s leaves comfortable headroom for slow CI runners.
		timeout: 120_000,
		env: {
			HOST: '0.0.0.0',
			PORT: '3000',
			DB_PATH: './tests/.e2e-data/test.db',
			MEDIA_DIR: './tests/.e2e-data/media',
			MEDIA_GRACE_PERIOD_DAYS: '7',
			MEDIA_PURGE_INTERVAL_SECONDS: '3600',
			AUTH_SECRET: 'e2e-test-secret-not-used-in-prod-32chars',
			GITHUB_OAUTH_CLIENT_ID: 'e2e-stub',
			GITHUB_OAUTH_CLIENT_SECRET: 'e2e-stub',
			ALLOWED_GITHUB_USER_IDS: '99999',
			EXTERNAL_BASE_URL: 'http://localhost:3000',
			CONFIG_PATH: './tests/e2e/fixtures/config.toml',
			LOG_LEVEL: 'warn'
		}
	}
});
