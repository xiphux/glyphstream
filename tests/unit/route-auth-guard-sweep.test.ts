/**
 * Every server route is either behind an auth guard or on an explicit, reasoned
 * public list — checked statically AND by calling every handler signed out.
 *
 * The hook deliberately doesn't gate /api/* (hooks.server.ts: "done in each
 * +server.ts to keep the hook simple"), so a new route that forgets
 * `requireUser` is open to the internet with nothing else to catch it. The
 * per-route tests only cover routes someone thought to test.
 *
 *   - Static: each exported handler calls requireUser / requireAdmin (a bare
 *     `!locals.user` check is not enough: it answers a locked session 401,
 *     sending it to /login instead of /unlock); /api/admin/** calls requireAdmin; each (app) server load
 *     awaits parent() or calls requireUserPage (CLAUDE.md).
 *   - Dynamic: each guarded handler, invoked with no user, empty params and an
 *     empty body, answers 401 — proving the guard runs BEFORE the handler reads
 *     params, the body, or the database — and answers an app-locked session 423.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { RequestEvent } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, closeTestDb } from './_helpers/test-db';

const ROUTES = join(__dirname, '../../src/routes');

/** Handlers reachable signed out, by design. Keyed `<route dir> <METHOD>`. */
const PUBLIC: Record<string, string> = {
	'/api/health GET': 'container HEALTHCHECK',
	'/manifest.webmanifest GET':
		'the web app manifest; browsers fetch it without credentials, and it holds nothing per-user',
	'/api/auth/logout POST': 'clears whatever session cookie is present; harmless without one',
	'/api/auth/github/callback GET': 'OAuth callback, protected by its signed state cookie',
	'/api/auth/oauth/[provider]/callback GET': 'OAuth callback, protected by its signed state cookie',
	'/api/auth/oauth/[provider]/login GET': 'starts a sign-in',
	'/api/auth/oauth/[provider]/join/start POST': 'invite redemption, gated by the invite token',
	'/api/auth/oauth/[provider]/setup/start POST': 'first-run setup, gated by setup state/token',
	'/api/auth/passkey/login/options POST': 'starts a sign-in',
	'/api/auth/passkey/login/verify POST': 'completes a sign-in',
	'/api/auth/join/passkey/options POST': 'invite redemption, gated by the invite token',
	'/api/auth/join/passkey/verify POST': 'invite redemption, gated by the invite token',
	'/api/auth/setup/passkey/options POST': 'first-run setup, gated by setup state/token',
	'/api/auth/setup/passkey/verify POST': 'first-run setup, gated by setup state/token',
	'/api/auth/app-lock/device POST':
		'sets the installed-app marker, which can only ADD a restriction',
	'/api/auth/unlock/options POST':
		'app-lock unlock: a LOCKED session has no user by design; gated on locals.appLock instead',
	'/api/auth/unlock/verify POST':
		'app-lock unlock: a LOCKED session has no user by design; gated on locals.appLock instead',
};

/**
 * (app) page loads that must guard with requireUserPage and must NOT await
 * parent(). Awaiting the parent couples the page to every layout
 * invalidation, so a turn completing or a tab refocusing re-serializes the
 * whole payload (CLAUDE.md, the `await parent()` convention). Re-adding it
 * regresses silently, which is what this list is for.
 */
const NO_PARENT: Record<string, string> = {
	'/(app)/chat/[id]': 'ships the whole active branch with content_html',
};

/** (app) server loads that legitimately need neither parent() nor requireUserPage. */
const APP_LOAD_EXEMPT: Record<string, string> = {
	'/(app)/settings/admin': 'unconditional redirect; the target does the auth check',
};

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'fallback'];
const GUARD = /\brequire(User|Admin)\s*\(/;

function walk(dir: string, match: RegExp): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory()
			? walk(join(dir, e.name), match)
			: match.test(e.name)
				? [join(dir, e.name)]
				: [],
	);
}

const routeDir = (file: string) => '/' + relative(ROUTES, join(file, '..')).split(sep).join('/');

interface Handler {
	file: string;
	route: string;
	method: string;
	body: string;
}

function serverHandlers(): Handler[] {
	return walk(ROUTES, /^\+server\.ts$/).flatMap((file) => {
		const src = readFileSync(file, 'utf8');
		const re = new RegExp(
			`export\\s+(?:const\\s+(${METHODS.join('|')})\\b|(?:async\\s+)?function\\s+(${METHODS.join('|')})\\b)`,
			'g',
		);
		const found = [...src.matchAll(re)];
		return found.map((m, i) => ({
			file,
			route: routeDir(file),
			method: m[1] ?? m[2],
			body: src.slice(m.index, found[i + 1]?.index ?? src.length),
		}));
	});
}

const handlers = serverHandlers();
const isPublic = (h: Handler) => `${h.route} ${h.method}` in PUBLIC;

describe('static: server handlers', () => {
	it('found the route tree', () => {
		expect(handlers.length).toBeGreaterThan(80);
	});

	it('every non-public handler has an auth guard', () => {
		const open = handlers.filter((h) => !isPublic(h) && !GUARD.test(h.body));
		expect(open.map((h) => `${h.route} ${h.method}`)).toEqual([]);
	});

	it('every /api/admin handler requires an ADMIN, not just a user', () => {
		const weak = handlers.filter(
			(h) => h.route.startsWith('/api/admin/') && !/\brequireAdmin\s*\(/.test(h.body),
		);
		expect(weak.map((h) => `${h.route} ${h.method}`)).toEqual([]);
	});

	it('the public list has no stale entries', () => {
		const live = new Set(handlers.map((h) => `${h.route} ${h.method}`));
		expect(Object.keys(PUBLIC).filter((k) => !live.has(k))).toEqual([]);
	});
});

describe('static: (app) server loads', () => {
	const loads = walk(join(ROUTES, '(app)'), /^\+(page|layout)\.server\.ts$/);

	it.each(loads.map((f) => [routeDir(f), f]))(
		'%s awaits parent() or requireUserPage',
		(route, f) => {
			if (route in APP_LOAD_EXEMPT) return;
			const src = readFileSync(f, 'utf8');
			if (route === '/(app)' && f.endsWith('+layout.server.ts')) {
				// The layout IS the redirect-on-no-auth the pages defer to.
				expect(src).toMatch(/locals\.user/);
				return;
			}
			expect(src).toMatch(/await\s+parent\(\)|requireUserPage\(/);
		},
	);

	it.each(Object.keys(NO_PARENT))('%s guards without awaiting parent()', (route) => {
		const file = join(ROUTES, route.slice(1), '+page.server.ts');
		// Its own comments explain why it skips `await parent()`; only code counts.
		const code = readFileSync(file, 'utf8')
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/\/\/.*$/gm, '');
		expect(code).toMatch(/requireUserPage\(/);
		expect(code).not.toMatch(/\bparent\s*\(/);
	});
});

describe('dynamic: guarded handlers refuse a signed-out caller first', () => {
	const modules = import.meta.glob<Record<string, unknown>>('../../src/routes/**/+server.ts');
	const guarded = handlers.filter((h) => !isPublic(h));

	beforeAll(() => {
		createTestDb();
	});
	afterAll(() => {
		closeTestDb();
	});

	const cases = guarded.flatMap((h) => [
		[`${h.route} ${h.method} signed out → 401`, h, { appLock: null }, 401] as const,
		[`${h.route} ${h.method} app-locked → 423`, h, { appLock: { locked: true } }, 423] as const,
	]);

	it.each(cases)('%s', async (_name, h, lock, expected) => {
		const key = '../../src/routes/' + relative(ROUTES, h.file).split(sep).join('/');
		const mod = await modules[key]();
		const fn = mod[h.method] as (e: RequestEvent) => unknown;
		const url = new URL(h.route.replace(/\/\([^)]+\)/g, ''), 'https://chat.example.test');
		const params = new Proxy({}, { get: () => 'x' });
		const event = {
			url,
			params,
			route: { id: h.route },
			locals: { user: null, sessionId: null, ...lock },
			cookies: { get: () => undefined, set: () => {}, delete: () => {}, getAll: () => [] },
			request: new Request(url, {
				method: h.method === 'fallback' ? 'POST' : h.method,
				headers: { 'content-type': 'application/json' },
				body: ['GET', 'HEAD'].includes(h.method) ? undefined : '{}',
			}),
			getClientAddress: () => '203.0.113.1',
			setHeaders: () => {},
			fetch,
			platform: undefined,
			isDataRequest: false,
			isSubRequest: false,
		} as unknown as RequestEvent;

		let status: number;
		try {
			status = ((await fn(event)) as Response).status;
		} catch (e) {
			if (!(e && typeof e === 'object' && 'status' in e)) throw e;
			status = Number(e.status);
		}
		expect(status).toBe(expected);
	});
});
