/**
 * The server `handle` hook itself: the CSRF gate, session resolution + cookie
 * renewal, and the unauthenticated auth-surface rate limit.
 *
 * Every piece it calls has its own tests (session.test.ts, rate-limit.test.ts,
 * request-path.test.ts), but the hook that wires them together had none — and
 * the wiring IS the security property. The gate matching the raw pathname, the
 * limiter running before session resolution, or a renewal that never reaches
 * the cookie would each leave every unit green. A Kit minor that changes how
 * `event.url.pathname` or `cookies` behave lands here too.
 *
 * Real session module on an in-memory DB; only the boot-time side effects
 * (sweepers, MCP, model-list warmup) are stubbed out.
 */
import { randomBytes, createHash } from 'node:crypto';
import type { Cookies, RequestEvent } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB }));

vi.mock('#lib/server/db/client.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/db/client.js')>()),
	dbFileBytes: () => ({ main: null, wal: null }),
	mmapBytes: () => null,
}));
vi.mock('#lib/server/env.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/env.js')>()),
	validateAuthMethodsEnabled: () => {},
	validateSecrets: () => {},
	compressDynamicResponses: () => false,
	authRateLimitMax: () => 3,
	authRateLimitWindowSeconds: () => 60,
}));
vi.mock('#lib/server/media/purger.js', () => ({
	startMediaPurger: vi.fn(),
	stopMediaPurger: vi.fn(),
}));
vi.mock('#lib/server/media/writable-probe.js', () => ({
	probeMediaDirsWritable: async () => {},
}));
vi.mock('#lib/server/auth/session-sweeper.js', () => ({
	startSessionSweeper: vi.fn(),
	stopSessionSweeper: vi.fn(),
}));
vi.mock('#lib/server/memory/embedding-backfill.js', () => ({
	startEmbeddingBackfiller: vi.fn(),
	stopEmbeddingBackfiller: vi.fn(),
}));
vi.mock('#lib/server/memory/topic-backfill.js', () => ({
	startTopicBackfiller: vi.fn(),
	stopTopicBackfiller: vi.fn(),
}));
vi.mock('#lib/server/memory/dreaming.js', () => ({
	startDreamingWorker: vi.fn(),
	stopDreamingWorker: vi.fn(),
}));
vi.mock('#lib/server/memory/conversation-summary.js', () => ({
	startConversationSummaryWorker: vi.fn(),
	stopConversationSummaryWorker: vi.fn(),
}));
vi.mock('#lib/server/mcp/bootstrap.js', () => ({ bootstrapMcp: vi.fn(async () => {}) }));
vi.mock('#lib/server/mcp/registry.js', () => ({ stopMcp: vi.fn(async () => {}) }));
vi.mock('#lib/server/endpoints/list-models.js', () => ({ listAllModels: vi.fn(async () => []) }));
vi.mock('#lib/server/code-interpreter/pool.js', () => ({ stopPool: vi.fn(async () => {}) }));

import { handle, handleError } from '../../src/hooks.server';
import { createSession } from '#lib/server/auth/session.js';
import { setAppLockTimeout } from '#lib/server/auth/app-lock.js';
import { resetRateLimits } from '#lib/server/rate-limit.js';
import { sessions } from '#lib/server/db/schema.js';

const ORIGIN = 'https://chat.example.test';
const SESSION_COOKIE = 'glyphstream_session';

interface CookieSet {
	name: string;
	value: string;
	opts: Parameters<Cookies['set']>[2];
}

function makeCookies(initial: Record<string, string>) {
	const jar = new Map(Object.entries(initial));
	const sets: CookieSet[] = [];
	const cookies = {
		get: (name: string) => jar.get(name),
		getAll: () => [...jar].map(([name, value]) => ({ name, value })),
		set: (name: string, value: string, opts: CookieSet['opts']) => {
			jar.set(name, value);
			sets.push({ name, value, opts });
		},
		delete: (name: string) => void jar.delete(name),
		serialize: () => '',
	} as unknown as Cookies;
	return { cookies, sets };
}

interface CallOpts {
	method?: string;
	headers?: Record<string, string>;
	cookies?: Record<string, string>;
	address?: string | (() => string);
	contentType?: string;
}

async function call(path: string, opts: CallOpts = {}) {
	const { cookies, sets } = makeCookies(opts.cookies ?? {});
	const url = new URL(path, ORIGIN);
	const locals = {} as App.Locals;
	const event = {
		url,
		request: new Request(url, { method: opts.method ?? 'GET', headers: opts.headers }),
		cookies,
		locals,
		getClientAddress:
			typeof opts.address === 'function' ? opts.address : () => opts.address ?? '203.0.113.7',
	} as unknown as RequestEvent;
	let seenUser: App.Locals['user'] | undefined;
	let transformed: string | undefined;
	const resolve = vi.fn(
		async (
			ev: RequestEvent,
			o?: { transformPageChunk?: (a: { html: string; done: boolean }) => string },
		) => {
			seenUser = ev.locals.user;
			transformed = o?.transformPageChunk?.({ html: '<html lang="en">', done: true });
			return new Response('<html lang="en"></html>', {
				headers: { 'content-type': opts.contentType ?? 'application/json' },
			});
		},
	);
	const response = await handle({ event, resolve } as Parameters<typeof handle>[0]);
	return { response, resolve, seenUser, sets, transformed };
}

beforeEach(() => {
	mocks.testDb = createTestDb();
	resetRateLimits();
});

afterEach(() => {
	closeTestDb();
});

describe('CSRF gate on /api/* state changes', () => {
	it.each(['cross-site', 'same-site', 'none'])('refuses Sec-Fetch-Site: %s', async (site) => {
		const { response, resolve } = await call('/api/conversations', {
			method: 'POST',
			headers: { 'sec-fetch-site': site, origin: ORIGIN },
		});
		expect(response.status).toBe(403);
		expect(resolve).not.toHaveBeenCalled();
	});

	it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('allows a same-origin %s', async (method) => {
		const { response, resolve } = await call('/api/conversations/x', {
			method,
			headers: { 'sec-fetch-site': 'same-origin' },
		});
		expect(response.status).toBe(200);
		expect(resolve).toHaveBeenCalledOnce();
	});

	it('trusts Sec-Fetch-Site over a matching Origin', async () => {
		// Attacker page can't forge Sec-Fetch-Site; a matching Origin alone
		// must not rescue a cross-site request.
		const { response } = await call('/api/conversations', {
			method: 'POST',
			headers: { 'sec-fetch-site': 'cross-site', origin: ORIGIN },
		});
		expect(response.status).toBe(403);
	});

	describe('legacy browser without Fetch-Metadata', () => {
		it('allows a matching Origin', async () => {
			const { response } = await call('/api/conversations', {
				method: 'POST',
				headers: { origin: ORIGIN },
			});
			expect(response.status).toBe(200);
		});

		it.each([
			['a foreign Origin', { origin: 'https://evil.example' }],
			['a scheme-mismatched Origin', { origin: 'http://chat.example.test' }],
			['no Origin at all', {}],
		])('refuses %s', async (_label, headers) => {
			const { response, resolve } = await call('/api/conversations', {
				method: 'DELETE',
				headers,
			});
			expect(response.status).toBe(403);
			expect(resolve).not.toHaveBeenCalled();
		});
	});

	// adapter-node guesses `https://` + Host for event.url (call() mirrors that
	// with ORIGIN), so a plain-http deploy's real origin never matches it.
	// Browsers send no Sec-Fetch-Site to an http target, leaving Origin.
	describe('plain-http deployment', () => {
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it("allows an Origin matching EXTERNAL_BASE_URL's origin", async () => {
			vi.stubEnv('EXTERNAL_BASE_URL', 'http://chat.example.test/');
			const { response } = await call('/api/conversations', {
				method: 'POST',
				headers: { origin: 'http://chat.example.test' },
			});
			expect(response.status).toBe(200);
		});

		it.each([
			['another http host', 'http://evil.example'],
			['another port on the declared host', 'http://chat.example.test:8080'],
		])('refuses %s', async (_label, origin) => {
			vi.stubEnv('EXTERNAL_BASE_URL', 'http://chat.example.test');
			const { response, resolve } = await call('/api/conversations', {
				method: 'POST',
				headers: { origin },
			});
			expect(response.status).toBe(403);
			expect(resolve).not.toHaveBeenCalled();
		});

		// A malformed EXTERNAL_BASE_URL must fail closed, not match a missing
		// or opaque Origin.
		it.each([
			['an unparseable value with no Origin', '192.168.1.20:3000', {}],
			['an empty value with no Origin', '', {}],
			['a scheme-less host:port with Origin: null', 'chat.lan:3000', { origin: 'null' }],
		])('refuses %s', async (_label, declared, headers: Record<string, string>) => {
			vi.stubEnv('EXTERNAL_BASE_URL', declared);
			const { response, resolve } = await call('/api/conversations', {
				method: 'POST',
				headers,
			});
			expect(response.status).toBe(403);
			expect(resolve).not.toHaveBeenCalled();
		});

		it("trusts no default origin when EXTERNAL_BASE_URL isn't set", async () => {
			vi.stubEnv('EXTERNAL_BASE_URL', undefined);
			const { response } = await call('/api/conversations', {
				method: 'POST',
				headers: { origin: 'http://localhost:5173' },
			});
			expect(response.status).toBe(403);
		});

		it('gives an https deployment no http exception', async () => {
			vi.stubEnv('EXTERNAL_BASE_URL', 'https://chat.example.test');
			const { response } = await call('/api/conversations', {
				method: 'POST',
				headers: { origin: 'http://chat.example.test' },
			});
			expect(response.status).toBe(403);
		});

		it('still lets Sec-Fetch-Site overrule a declared-origin match', async () => {
			vi.stubEnv('EXTERNAL_BASE_URL', 'http://chat.example.test');
			const { response } = await call('/api/conversations', {
				method: 'POST',
				headers: { 'sec-fetch-site': 'cross-site', origin: 'http://chat.example.test' },
			});
			expect(response.status).toBe(403);
		});
	});

	it('gates a percent-encoded /api path, not just the literal prefix', async () => {
		const { response, resolve } = await call('/%61pi/conversations', {
			method: 'POST',
			headers: { 'sec-fetch-site': 'cross-site' },
		});
		expect(response.status).toBe(403);
		expect(resolve).not.toHaveBeenCalled();
	});

	it('leaves GET alone, cross-site or not', async () => {
		const { response } = await call('/api/conversations', {
			headers: { 'sec-fetch-site': 'cross-site' },
		});
		expect(response.status).toBe(200);
	});
});

describe('session resolution', () => {
	it('resolves the cookie to locals.user before the route runs', async () => {
		const u = seedUser();
		const { token } = createSession(u.id);
		const { seenUser, sets } = await call('/', { cookies: { [SESSION_COOKIE]: token } });
		expect(seenUser?.id).toBe(u.id);
		// Far from expiry: no cookie churn on every request.
		expect(sets).toEqual([]);
	});

	it('leaves locals.user null for an unknown token', async () => {
		const { seenUser } = await call('/', {
			cookies: { [SESSION_COOKIE]: randomBytes(20).toString('base64url') },
		});
		expect(seenUser).toBeNull();
	});

	it('re-issues the SAME token with the slid expiry when the session renews', async () => {
		const u = seedUser();
		const token = randomBytes(20).toString('base64url');
		const oneDay = 24 * 60 * 60 * 1000;
		mocks.testDb
			.insert(sessions)
			.values({
				id: createHash('sha256').update(token).digest('hex'),
				userId: u.id,
				expiresAt: Date.now() + oneDay,
				createdAt: Date.now() - oneDay,
			})
			.run();

		const { seenUser, sets } = await call('/', { cookies: { [SESSION_COOKIE]: token } });
		expect(seenUser?.id).toBe(u.id);
		expect(sets).toHaveLength(1);
		expect(sets[0]).toMatchObject({ name: SESSION_COOKIE, value: token });
		expect(sets[0].opts).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' });
		expect(sets[0].opts?.expires?.getTime()).toBeGreaterThan(Date.now() + 7 * oneDay);
	});
});

describe('auth-surface rate limit', () => {
	const login = (o: CallOpts = {}) =>
		call('/api/auth/passkey/login/options', {
			method: 'POST',
			headers: { 'sec-fetch-site': 'same-origin' },
			...o,
		});

	it('refuses an anonymous flood with 429 + Retry-After, before the route runs', async () => {
		for (let i = 0; i < 3; i++) expect((await login()).response.status).toBe(200);
		const { response, resolve } = await login();
		expect(response.status).toBe(429);
		expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
		expect(resolve).not.toHaveBeenCalled();
	});

	it('keys by client address', async () => {
		for (let i = 0; i < 3; i++) await login();
		expect((await login()).response.status).toBe(429);
		expect((await login({ address: '198.51.100.9' })).response.status).toBe(200);
	});

	it('never limits a signed-in request, even from an exhausted address', async () => {
		// Behind a proxy with no ADDRESS_HEADER everyone shares one key; limiting
		// signed-in requests would let an anonymous flood lock users out of
		// logout and session revocation.
		for (let i = 0; i < 3; i++) await login();
		expect((await login()).response.status).toBe(429);
		const u = seedUser();
		const { token } = createSession(u.id);
		const { response } = await call('/api/auth/sessions', {
			method: 'DELETE',
			headers: { 'sec-fetch-site': 'same-origin' },
			cookies: { [SESSION_COOKIE]: token },
		});
		expect(response.status).toBe(200);
	});

	it('never limits an app-LOCKED session either — its unlock must not queue behind a flood', async () => {
		// A locked session has no locals.user by design, but it is still a real
		// account's session; the exemption keys on the session, not the user.
		for (let i = 0; i < 3; i++) await login();
		expect((await login()).response.status).toBe(429);
		const u = seedUser();
		setAppLockTimeout(u.id, 60_000);
		const { token } = createSession(u.id, null, 0); // born locked
		const { response, seenUser } = await call('/api/auth/unlock/options', {
			method: 'POST',
			headers: { 'sec-fetch-site': 'same-origin' },
			cookies: { [SESSION_COOKIE]: token },
		});
		expect(response.status).toBe(200);
		expect(seenUser).toBeNull();
	});

	it('counts a percent-encoded /api/auth path against the same bucket', async () => {
		for (let i = 0; i < 3; i++) await login();
		const { response } = await call('/api/%61uth/passkey/login/options', {
			method: 'POST',
			headers: { 'sec-fetch-site': 'same-origin' },
		});
		expect(response.status).toBe(429);
	});

	it('stays closed when the client address is unknowable', async () => {
		const address = () => {
			throw new Error('no address');
		};
		for (let i = 0; i < 3; i++) expect((await login({ address })).response.status).toBe(200);
		expect((await login({ address })).response.status).toBe(429);
	});

	it('does not touch the rest of the API', async () => {
		for (let i = 0; i < 5; i++) {
			expect((await call('/api/health')).response.status).toBe(200);
		}
	});
});

describe('app lock idle window', () => {
	it('slides only on the keep-alive, not on other requests from the installed app', async () => {
		const u = seedUser();
		setAppLockTimeout(u.id, 60_000);
		const now = Date.now();
		// 40s left of a one-minute window: past the 15s throttle, due a slide.
		const { token } = createSession(u.id, null, now + 40_000);
		const cookies = { [SESSION_COOKIE]: token, glyphstream_installed_app: '1' };
		const until = () => mocks.testDb.select().from(sessions).get()!.unlockedUntil!;

		await call('/api/conversations/abc/stream-status', { cookies });
		expect(until()).toBe(now + 40_000);

		const { seenUser } = await call('/api/auth/app-lock', { cookies });
		expect(seenUser).not.toBeNull();
		expect(until()).toBeGreaterThanOrEqual(now + 60_000);
	});
});

describe('response decoration', () => {
	it('applies security headers', async () => {
		const { response } = await call('/api/health');
		expect(response.headers.get('x-content-type-options')).toBe('nosniff');
	});

	it("applies them to the gates' own refusals too", async () => {
		const { response } = await call('/api/conversations', {
			method: 'POST',
			headers: { 'sec-fetch-site': 'cross-site' },
		});
		expect(response.status).toBe(403);
		expect(response.headers.get('x-content-type-options')).toBe('nosniff');
	});

	it('stamps Server-Timing on documents, with process metrics only when signed in', async () => {
		const anon = await call('/login', { contentType: 'text/html' });
		const anonTiming = anon.response.headers.get('server-timing') ?? '';
		expect(anonTiming).toMatch(/\bssr;dur=/);
		expect(anonTiming).not.toMatch(/\bproc;dur=/);

		const u = seedUser();
		const { token } = createSession(u.id);
		const signedIn = await call('/', {
			contentType: 'text/html',
			cookies: { [SESSION_COOKIE]: token },
		});
		expect(signedIn.response.headers.get('server-timing')).toMatch(/\bproc;dur=/);

		const api = await call('/api/health');
		expect(api.response.headers.get('server-timing')).toBeNull();
	});

	it('injects only a known theme into <html>', async () => {
		expect((await call('/', { cookies: { 'gs-theme': 'claude' } })).transformed).toBe(
			'<html lang="en" data-theme="claude">',
		);
		expect(
			(await call('/', { cookies: { 'gs-theme': '"><script>alert(1)</script>' } })).transformed,
		).toBeUndefined();
	});
});

// What handleError logs. It only ever logs (it returns nothing), so the log line
// is its whole observable behaviour.
describe('handleError', () => {
	const event = {
		request: new Request('http://localhost/x', { method: 'POST' }),
		url: new URL('http://localhost/x'),
	} as RequestEvent;
	const logged = () => vi.mocked(console.error).mock.calls.map((c) => String(c[0]));

	beforeEach(() => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("logs a framework 5xx by its message — it's a plain object, not an Error", () => {
		void handleError({ kind: 'framework', error: { status: 503, message: 'Gone fishing' }, event });
		expect(logged()).toEqual([expect.stringContaining('→ 503:\nGone fishing')]);
		expect(logged()[0]).not.toContain('[object Object]');
	});

	it('logs an unexpected throw as a 500, with its stack', () => {
		void handleError({ kind: 'unknown', error: new Error('boom'), event });
		expect(logged()).toEqual([expect.stringMatching(/→ 500:\nError: boom\n\s+at /)]);
	});

	it('stays quiet for a framework 4xx and for a deliberate error()', () => {
		void handleError({ kind: 'framework', error: { status: 404, message: 'Not Found' }, event });
		void handleError({ kind: 'app', error: { status: 500, message: 'Nope' }, event });
		expect(logged()).toEqual([]);
	});
});
