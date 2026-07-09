import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// Foundry allocates a unique port block per worktree so parallel e2e runs
// don't fight over the same sockets. Each var falls back to its historical
// hardcoded default, so a plain `pnpm test:e2e` outside Foundry is unchanged.
const appPort = Number(process.env.E2E_PORT ?? 3000); // the compiled app
const mockPort = Number(process.env.MOCK_UPSTREAM_PORT ?? 3001); // mock upstream
const baseURL = `http://localhost:${appPort}`;

// The fixture config.toml points the mock endpoint at :3001. When Foundry
// hands us a different mock port, rewrite base_url into a generated sibling
// config so the app dials the right upstream. At the default port we use the
// fixture verbatim — no file written, byte-for-byte the prior behaviour.
const FIXTURE_CONFIG = resolve('./tests/e2e/fixtures/config.toml');
let configPath = FIXTURE_CONFIG;
if (mockPort !== 3001) {
	configPath = resolve('./tests/e2e/fixtures/config.generated.toml');
	const toml = readFileSync(FIXTURE_CONFIG, 'utf-8').replaceAll(
		'localhost:3001',
		`localhost:${mockPort}`,
	);
	writeFileSync(configPath, toml);
}

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
		baseURL,
		storageState: './tests/.e2e-data/auth.json',
		trace: 'on-first-retry',
	},
	globalSetup: './tests/e2e/global-setup.ts',
	projects: [
		{
			name: 'chromium-desktop',
			use: { ...devices['Desktop Chrome'] },
		},
		{
			name: 'chromium-mobile',
			use: { ...devices['Pixel 5'] },
		},
	],
	// Two servers: the mock OpenAI upstream (started first so it's ready
	// when the app lists models) and the app itself. Playwright waits for
	// each `url` to respond before running tests, so the app's first
	// /v1/models call always finds the mock up.
	webServer: [
		{
			// Dependency-free Node http server — no build step. Its readiness
			// probe is GET /v1/models (returns 200 once listening).
			command: 'node tests/e2e/fixtures/mock-upstream.mjs',
			url: `http://localhost:${mockPort}/v1/models`,
			reuseExistingServer: !process.env.CI,
			timeout: 30_000,
			env: { MOCK_UPSTREAM_PORT: String(mockPort) },
		},
		{
			// Build then run the compiled adapter-node handler. `&&` chained
			// so we fail fast if the build breaks.
			command: 'pnpm build && node build/index.js',
			url: `${baseURL}/api/health`,
			reuseExistingServer: !process.env.CI,
			// Build can take 10-15s on a cold cache, then the server boots in <1s.
			// 120s leaves comfortable headroom for slow CI runners.
			timeout: 120_000,
			env: {
				HOST: '0.0.0.0',
				PORT: String(appPort),
				DB_PATH: './tests/.e2e-data/test.db',
				MEDIA_DIR: './tests/.e2e-data/media',
				AUTH_SECRET: 'e2e-test-secret-not-used-in-prod-32chars',
				GITHUB_OAUTH_CLIENT_ID: 'e2e-stub',
				GITHUB_OAUTH_CLIENT_SECRET: 'e2e-stub',
				ALLOWED_GITHUB_USER_IDS: '99999',
				EXTERNAL_BASE_URL: baseURL,
				CONFIG_PATH: configPath,
				LOG_LEVEL: 'warn',
			},
		},
	],
});
