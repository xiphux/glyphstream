/**
 * Every server route is either behind an auth guard or on an explicit, reasoned
 * public list — checked statically AND by calling every handler signed out.
 *
 * The hook deliberately doesn't gate /api/* (hooks.server.ts: "done in each
 * +server.ts to keep the hook simple"), so a new route that forgets
 * `requireUser` is open to the internet with nothing else to catch it. The
 * per-route tests only cover routes someone thought to test.
 *
 *   - Static: each exported handler calls requireUser / requireAdmin (or checks
 *     `!locals.user`); /api/admin/** calls requireAdmin; each (app) server load
 *     awaits parent() or calls requireUserPage (CLAUDE.md).
 *   - Dynamic: each guarded handler, invoked with no user, empty params and an
 *     empty body, answers 401 — proving the guard runs BEFORE the handler reads
 *     params, the body, or the database.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { RequestEvent } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB }));
vi.mock('$lib/server/db/client', () => ({ getDb: () => mocks.testDb, closeDb: () => {} }));

const ROUTES = join(__dirname, '../../src/routes');

/** Handlers reachable signed out, by design. Keyed `<route dir> <METHOD>`. */
const PUBLIC: Record<string, string> = {
	'/api/health GET': 'container HEALTHCHECK',
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
};

/** (app) server loads that legitimately need neither parent() nor requireUserPage. */
const APP_LOAD_EXEMPT: Record<string, string> = {
	'/(app)/settings/admin': 'unconditional redirect; the target does the auth check',
};

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'fallback'];
const GUARD = /\brequire(User|Admin)\s*\(|if\s*\(\s*!\s*locals\.user\s*\)/;

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
});

describe('dynamic: guarded handlers refuse a signed-out caller first', () => {
	const modules = import.meta.glob<Record<string, unknown>>('../../src/routes/**/+server.ts');
	const guarded = handlers.filter((h) => !isPublic(h));

	beforeAll(() => {
		mocks.testDb = createTestDb();
	});
	afterAll(() => {
		closeTestDb();
	});

	it.each(guarded.map((h) => [`${h.route} ${h.method}`, h] as const))('%s', async (_name, h) => {
		const key = '../../src/routes/' + relative(ROUTES, h.file).split(sep).join('/');
		const mod = await modules[key]();
		const fn = mod[h.method] as (e: RequestEvent) => unknown;
		const url = new URL(h.route.replace(/\/\([^)]+\)/g, ''), 'https://chat.example.test');
		const params = new Proxy({}, { get: () => 'x' });
		const event = {
			url,
			params,
			route: { id: h.route },
			locals: { user: null, sessionId: null },
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
		expect(status).toBe(401);
	});
});
