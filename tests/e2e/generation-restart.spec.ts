import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import process from 'node:process';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { migrate } from 'drizzle-orm/node-sqlite/migrator';
import { test, expect, SERVER_ERRORS_LOG, type APIRequestContext } from './fixtures/test';
import { selectModel } from './helpers';

/**
 * A queued image generation survives GlyphStream being killed and restarted.
 *
 * The unit tests simulate a restart by resetting in-process state; this one
 * does it for real, which is the only way to cover what they mock around: the
 * startup wiring in hooks.server.ts, the migration against a real database
 * file, and resume in a fresh process. It needs its own server to kill, so it
 * boots one — the production build the suite already made, on a free port,
 * with its own database — beside the shared one, which it never touches.
 *
 * The endpoint is paused first so the generation is still queued when the
 * process dies (the mock renders instantly). The pause is persisted too, so the
 * restarted server resumes the job into a paused queue; resuming the endpoint
 * is what finally lets it run.
 */

const ROOT = resolve('./tests/.e2e-data/restart');
const DB_PATH = resolve(ROOT, 'test.db');
const USER_ID = '00000000-0000-0000-0000-00000000a11a';
const SESSION_COOKIE = 'glyphstream_session';

/** The fixture config the suite's own server uses (see playwright.config.ts). */
function configPath(): string {
	const mockPort = Number(process.env.MOCK_UPSTREAM_PORT ?? 3001);
	return mockPort === 3001
		? resolve('./tests/e2e/fixtures/config.toml')
		: resolve('./tests/e2e/fixtures/config.generated.toml');
}

function freePort(): Promise<number> {
	return new Promise((ok, fail) => {
		const srv = createServer();
		srv.once('error', fail);
		srv.listen(0, '127.0.0.1', () => {
			const addr = srv.address();
			const port = typeof addr === 'object' && addr ? addr.port : 0;
			srv.close(() => ok(port));
		});
	});
}

/** A fresh database: migrated, one admin user, one session. Returns the cookie. */
function seed(): string {
	rmSync(ROOT, { recursive: true, force: true });
	mkdirSync(resolve(ROOT, 'media'), { recursive: true });
	const sqlite = new DatabaseSync(DB_PATH);
	try {
		migrate(drizzle({ client: sqlite }), { migrationsFolder: resolve('./drizzle') });
		const now = Date.now();
		sqlite
			.prepare(
				`INSERT INTO users (id, email, display_name, role, created_at, last_login_at)
				 VALUES (?, 'restart@example.test', 'Restart Tester', 'admin', ?, ?)`,
			)
			.run(USER_ID, now, now);
		const token = randomBytes(20).toString('base64url');
		sqlite
			.prepare(`INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`)
			.run(createHash('sha256').update(token).digest('hex'), USER_ID, now + 86_400_000, now);
		return token;
	} finally {
		sqlite.close();
	}
}

function jobCount(): number {
	const sqlite = new DatabaseSync(DB_PATH);
	try {
		sqlite.exec('PRAGMA busy_timeout = 5000');
		return (sqlite.prepare('SELECT count(*) AS n FROM generation_jobs').get() as { n: number }).n;
	} finally {
		sqlite.close();
	}
}

/**
 * Boot the production build on `port`. Loaded with the same error capture as
 * the suite's own server, so a `console.error` or uncaught exception in this
 * process — a resumed job failing, say — fails the test through the fixture
 * rather than scrolling past unseen. Everything it prints is also appended to
 * `output`, for the report if the test fails.
 */
async function startServer(port: number, output: string[]): Promise<ChildProcess> {
	const server = spawn(
		process.execPath,
		['--import', './tests/e2e/fixtures/capture-server-errors.mjs', 'build/index.js'],
		{
			env: {
				...process.env,
				HOST: '127.0.0.1',
				PORT: String(port),
				DB_PATH,
				MEDIA_DIR: resolve(ROOT, 'media'),
				AUTH_SECRET: 'e2e-restart-secret-not-used-in-prod-32chars',
				GITHUB_OAUTH_CLIENT_ID: 'e2e-stub',
				GITHUB_OAUTH_CLIENT_SECRET: 'e2e-stub',
				EXTERNAL_BASE_URL: `http://localhost:${port}`,
				CONFIG_PATH: configPath(),
				LOG_LEVEL: 'warn',
				E2E_SERVER_ERRORS_LOG: SERVER_ERRORS_LOG,
			},
			stdio: ['ignore', 'pipe', 'pipe'],
		},
	);
	const record = (chunk: Buffer) => output.push(chunk.toString());
	server.stdout?.on('data', record);
	server.stderr?.on('data', record);
	for (let i = 0; i < 100; i++) {
		try {
			if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return server;
		} catch {
			// not listening yet
		}
		await new Promise((r) => setTimeout(r, 100));
	}
	server.kill('SIGKILL');
	throw new Error('the restart-test server never came up');
}

/** Kill with no chance to clean up — a crash, an OOM kill, a pulled plug. */
async function crash(server: ChildProcess) {
	// Already gone — it died on its own, or this is the first server after a
	// restart that failed to come up. 'exit' is never re-emitted to a listener
	// added now, so waiting for it would hang the test until its timeout and bury
	// the error that actually failed it.
	if (server.exitCode !== null || server.signalCode !== null) return;
	const exited = new Promise((r) => server.once('exit', r));
	server.kill('SIGKILL');
	await exited;
}

async function setPaused(request: APIRequestContext, base: string, paused: boolean) {
	const res = await request.fetch(`${base}/api/admin/endpoints/mock/pause`, {
		method: paused ? 'PUT' : 'DELETE',
		headers: { 'Sec-Fetch-Site': 'same-origin' },
	});
	expect(res.ok()).toBe(true);
}

test('a queued generation survives the server being killed and restarted', async ({
	browser,
}, testInfo) => {
	test.skip(testInfo.project.name !== 'chromium-desktop', 'one real restart is enough');
	test.skip(!existsSync('build/index.js'), 'needs the production build');
	test.setTimeout(90_000);

	const token = seed();
	const port = await freePort();
	const base = `http://localhost:${port}`;
	const output: string[] = [];
	let server = await startServer(port, output);
	const context = await browser.newContext();
	try {
		await context.addCookies([
			{ name: SESSION_COOKIE, value: token, domain: 'localhost', path: '/', httpOnly: true },
		]);
		const page = await context.newPage();

		// Queue an image behind a paused endpoint, so it's still waiting when the
		// process dies.
		await setPaused(context.request, base, true);
		await page.goto(`${base}/`);
		await expect(page.getByRole('button', { name: 'Select model' })).toContainText('Mock Chat');
		await selectModel(page, /Mock Image/);
		await page.locator('textarea').first().fill('a lighthouse at dusk');
		await page.getByRole('button', { name: 'Send message' }).click();
		await page.waitForURL(/\/chat\/[^/]+$/);
		await expect(page.getByText('Paused', { exact: true })).toBeVisible();
		expect(jobCount()).toBe(1);

		await crash(server);
		server = await startServer(port, output);

		// A page load after the restart sees the job back in flight — the first
		// signed-in request resumes the queue before its own reads (this reload,
		// or one the still-open page got in first) — still waiting, as the pause
		// survived too.
		await page.reload();
		await expect(page.getByText('Queued', { exact: true })).toBeVisible();
		await expect(page.locator('img[src*="/api/media/"]')).toHaveCount(0);
		expect(jobCount()).toBe(1);

		// Resume: it runs, lands, and leaves nothing queued. The page picks the
		// result up through its recovery poll.
		await setPaused(context.request, base, false);
		await expect(page.locator('img[src*="/api/media/"]').first()).toBeVisible({
			timeout: 15_000,
		});
		expect(jobCount()).toBe(0);
	} finally {
		if (testInfo.status !== testInfo.expectedStatus) {
			await testInfo.attach('restart-server-output', {
				body: output.join('') || '(no output)',
				contentType: 'text/plain',
			});
		}
		await context.close();
		await crash(server);
		rmSync(ROOT, { recursive: true, force: true });
	}
});
