/**
 * Route-handler tests for /api/auth/github/callback — the single
 * landing point for every GitHub OAuth round-trip. Three flows fan
 * out from one entry point based on which cookies are present
 * (setup carry, link state, or just login state), each with several
 * refusal branches. A regression here breaks login, the bootstrap
 * path, AND the link-new flow simultaneously — high blast radius,
 * worth direct coverage.
 *
 * Pattern: mock `$lib/server/db/client` to hand back an in-memory
 * test DB, mock `fetchGithubProfile` so the OAuth round-trip is
 * deterministic, construct a minimal fake event, call the handler,
 * and assert on the thrown redirect / DB side effects.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isRedirect, type Cookies, type Redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedOAuthAccount, seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({
	testDb: null as unknown as TestDB,
	profile: { id: 0, login: '', name: null as string | null, email: null as string | null },
	profileError: null as Error | null,
}));

vi.mock('$lib/server/db/client', () => ({
	getDb: () => mocks.testDb,
	closeDb: () => {},
}));

vi.mock('$lib/server/auth/github', async () => {
	const actual =
		await vi.importActual<typeof import('$lib/server/auth/github')>('$lib/server/auth/github');
	return {
		...actual,
		fetchGithubProfile: vi.fn(async () => {
			if (mocks.profileError) throw mocks.profileError;
			return mocks.profile;
		}),
	};
});

vi.mock('$lib/server/env', () => ({
	authSecret: () => 'test-secret-do-not-use-in-prod',
	// Other env getters aren't called by the callback path — github.ts
	// only reads them inside getGithubClient(), which we never invoke
	// because fetchGithubProfile is mocked.
}));

import { GET } from '../../src/routes/api/auth/github/callback/+server';
import { LINK_STATE_COOKIE, OAuth2RequestError, STATE_COOKIE } from '$lib/server/auth/github';
import { SETUP_GITHUB_CARRY_COOKIE } from '$lib/server/auth/setup';
import { sign } from '$lib/server/auth/signed-cookies';
import { oauthAccounts, users } from '$lib/server/db/schema';

function fakeCookies(initial: Record<string, string> = {}) {
	const store = new Map(Object.entries(initial));
	const cookies = {
		get: (name: string) => store.get(name),
		set: (name: string, value: string) => {
			store.set(name, value);
		},
		delete: (name: string) => {
			store.delete(name);
		},
	} as unknown as Cookies;
	return { store, cookies };
}

function fakeUrl(query: Record<string, string> = {}): URL {
	const u = new URL('http://localhost:5173/api/auth/github/callback');
	for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
	return u;
}

interface Event {
	url: URL;
	cookies: Cookies;
	locals: { user: { id: string; displayName: string | null; email: string | null } | null };
}

function mkEvent(over: Partial<Event> = {}): Event {
	return {
		url: over.url ?? fakeUrl(),
		cookies: over.cookies ?? fakeCookies().cookies,
		locals: over.locals ?? { user: null },
	};
}

/**
 * SvelteKit handlers can be sync or async; running the call inside
 * an async IIFE turns sync throws into rejected promises so a single
 * helper covers both shapes.
 */
async function expectRedirect(fn: () => unknown): Promise<Redirect> {
	try {
		await (async () => fn())();
		throw new Error('expected redirect, none thrown');
	} catch (e) {
		if (isRedirect(e)) return e;
		throw e;
	}
}

beforeEach(() => {
	mocks.testDb = createTestDb();
	mocks.profile = { id: 1234, login: 'octocat', name: null, email: null };
	mocks.profileError = null;
});

afterEach(() => {
	closeTestDb();
});

// --- Setup branch ---------------------------------------------------------

describe('GitHub callback — setup branch', () => {
	function setupEvent(over: { state?: string; code?: string; carry?: string } = {}) {
		const state = over.state ?? 'setup-state';
		const carry = over.carry ?? sign({ displayName: 'Operator', email: 'op@x' }, 600_000);
		const { store, cookies } = fakeCookies({
			[STATE_COOKIE]: state,
			[SETUP_GITHUB_CARRY_COOKIE]: carry,
		});
		const url = fakeUrl({ code: over.code ?? 'authcode', state });
		return { event: mkEvent({ url, cookies }), store };
	}

	it('creates user + binding + session and redirects to / on success', async () => {
		mocks.profile = { id: 999, login: 'octocat', name: 'Octo', email: 'profile@x' };
		const { event, store } = setupEvent();

		const r = await expectRedirect(() => GET(event as never));
		expect(r.location).toBe('/');

		const userRows = mocks.testDb.select().from(users).all();
		expect(userRows).toHaveLength(1);
		// Operator-typed display name wins over GitHub's profile.name.
		expect(userRows[0].displayName).toBe('Operator');
		// Operator-typed email wins over GitHub's profile.email.
		expect(userRows[0].email).toBe('op@x');

		const accountRows = mocks.testDb.select().from(oauthAccounts).all();
		expect(accountRows).toHaveLength(1);
		expect(accountRows[0].provider).toBe('github');
		expect(accountRows[0].externalId).toBe('999');
		expect(accountRows[0].externalUsername).toBe('octocat');

		expect(store.has('glyphstream_session')).toBe(true);
	});

	it('falls back to profile.email when the typed email is null', async () => {
		mocks.profile = { id: 1, login: 'a', name: null, email: 'github@x' };
		const { event } = setupEvent({
			carry: sign({ displayName: 'Op', email: null }, 600_000),
		});

		await expectRedirect(() => GET(event as never));

		const u = mocks.testDb.select().from(users).get()!;
		expect(u.email).toBe('github@x');
	});

	it('clears the setup carry + state cookies even on failure', async () => {
		const { event, store } = setupEvent({ state: 'a', code: 'b' });
		// Force a state mismatch by tampering with the URL.
		event.url = fakeUrl({ code: 'b', state: 'mismatch' });

		await expectRedirect(() => GET(event as never));

		expect(store.has(SETUP_GITHUB_CARRY_COOKIE)).toBe(false);
		expect(store.has(STATE_COOKIE)).toBe(false);
	});

	it('refuses with invalid_oauth_state when state mismatches', async () => {
		const { event } = setupEvent();
		event.url = fakeUrl({ code: 'c', state: 'wrong' });

		const r = await expectRedirect(() => GET(event as never));
		expect(r.location).toBe('/setup?error=invalid_oauth_state');
	});

	it('refuses with invalid_oauth_state when carry is missing', async () => {
		const { store, cookies } = fakeCookies({
			[STATE_COOKIE]: 'a',
			// no carry — but a stale tab race could land here
			[SETUP_GITHUB_CARRY_COOKIE]: 'malformed.signature',
		});
		const event = mkEvent({ url: fakeUrl({ code: 'c', state: 'a' }), cookies });

		const r = await expectRedirect(() => GET(event as never));
		expect(r.location).toBe('/setup?error=invalid_oauth_state');
		// Belt-and-suspenders: cookies cleared.
		expect(store.has(SETUP_GITHUB_CARRY_COOKIE)).toBe(false);
	});

	it('refuses with invalid_oauth_state when carry is expired', async () => {
		const { event } = setupEvent({
			carry: sign({ displayName: 'Op', email: null }, -1_000),
		});

		const r = await expectRedirect(() => GET(event as never));
		expect(r.location).toBe('/setup?error=invalid_oauth_state');
	});

	it('redirects to /login when a parallel tab completed setup mid-flow', async () => {
		// Someone else seeded a user while this OAuth round-trip was
		// in flight — the gate is closed. SETUP_TOKEN re-validation is
		// intentionally NOT re-run here (the carry already proves it);
		// only the user-count check needs to fire.
		seedUser();
		const { event } = setupEvent();

		const r = await expectRedirect(() => GET(event as never));
		expect(r.location).toBe('/login');
	});

	it('does NOT re-check SETUP_TOKEN on the callback (gh redirect lacks it)', async () => {
		// Regression guard: a previous version called setupGate(url) here,
		// which spuriously failed when SETUP_TOKEN was configured because
		// GitHub's redirect URI doesn't carry the operator's token. The
		// signed carry's existence is the proof we want.
		const { event } = setupEvent();
		// Token isn't in the URL — that's exactly what GitHub redirects to.
		// Success path should still complete.
		await expectRedirect(() => GET(event as never));
		expect(mocks.testDb.select().from(users).all()).toHaveLength(1);
	});

	it('refuses with oauth_exchange_failed on an OAuth2RequestError', async () => {
		mocks.profileError = new OAuth2RequestError(
			'https://example.com',
			'bad_code',
			'description',
			null,
		);
		const { event } = setupEvent();

		const r = await expectRedirect(() => GET(event as never));
		expect(r.location).toBe('/setup?error=oauth_exchange_failed');
	});

	it('refuses with upstream_failure on any other fetch error', async () => {
		mocks.profileError = new Error('network down');
		const { event } = setupEvent();

		const r = await expectRedirect(() => GET(event as never));
		expect(r.location).toBe('/setup?error=upstream_failure');
	});
});

// --- Link branch ----------------------------------------------------------

describe('GitHub callback — link branch', () => {
	function linkEvent(opts: { userId: string; state?: string; code?: string } = { userId: '' }) {
		const state = opts.state ?? 'link-state';
		const { store, cookies } = fakeCookies({ [LINK_STATE_COOKIE]: state });
		const url = fakeUrl({ code: opts.code ?? 'authcode', state });
		return {
			event: mkEvent({
				url,
				cookies,
				locals: { user: { id: opts.userId, displayName: 'U', email: null } },
			}),
			store,
		};
	}

	it('adds the binding and redirects to ?link=success', async () => {
		const u = seedUser();
		mocks.profile = { id: 555, login: 'newhandle', name: null, email: 'np@x' };
		const { event } = linkEvent({ userId: u.id });

		const r = await expectRedirect(() => GET(event as never));
		expect(r.location).toBe('/settings/security?link=success');

		const accounts = mocks.testDb
			.select()
			.from(oauthAccounts)
			.where(eq(oauthAccounts.userId, u.id))
			.all();
		expect(accounts).toHaveLength(1);
		expect(accounts[0].provider).toBe('github');
		expect(accounts[0].externalId).toBe('555');
		expect(accounts[0].externalUsername).toBe('newhandle');
	});

	it('redirects to /login when the session is gone mid-flow', async () => {
		// linkState present but locals.user is null — operator signed
		// out in a different tab between start and callback.
		const { store, cookies } = fakeCookies({ [LINK_STATE_COOKIE]: 's' });
		const event = mkEvent({
			url: fakeUrl({ code: 'c', state: 's' }),
			cookies,
			locals: { user: null },
		});

		const r = await expectRedirect(() => GET(event as never));
		expect(r.location).toBe('/login');
		// State cookie still gets cleared.
		expect(store.has(LINK_STATE_COOKIE)).toBe(false);
	});

	it('refuses with ?link=invalid_state when state mismatches', async () => {
		const u = seedUser();
		const { event } = linkEvent({ userId: u.id, state: 'right' });
		event.url = fakeUrl({ code: 'c', state: 'wrong' });

		const r = await expectRedirect(() => GET(event as never));
		expect(r.location).toBe('/settings/security?link=invalid_state');
	});

	it('refuses with ?link=already_linked when the binding exists', async () => {
		const u = seedUser();
		seedOAuthAccount(u.id, { provider: 'github', externalId: '777' });
		mocks.profile = { id: 777, login: 'same', name: null, email: null };
		const { event } = linkEvent({ userId: u.id });

		const r = await expectRedirect(() => GET(event as never));
		expect(r.location).toBe('/settings/security?link=already_linked');

		// No second row created.
		const count = mocks.testDb
			.select()
			.from(oauthAccounts)
			.where(eq(oauthAccounts.userId, u.id))
			.all().length;
		expect(count).toBe(1);
	});

	it('refuses with ?link=exchange_failed on OAuth2RequestError', async () => {
		const u = seedUser();
		mocks.profileError = new OAuth2RequestError(
			'https://example.com',
			'bad_code',
			'description',
			null,
		);
		const { event } = linkEvent({ userId: u.id });

		const r = await expectRedirect(() => GET(event as never));
		expect(r.location).toBe('/settings/security?link=exchange_failed');
	});
});

// --- Login branch ---------------------------------------------------------

describe('GitHub callback — login branch', () => {
	function loginEvent(opts: { state?: string; code?: string } = {}) {
		const state = opts.state ?? 'login-state';
		const { cookies } = fakeCookies({ [STATE_COOKIE]: state });
		const url = fakeUrl({ code: opts.code ?? 'authcode', state });
		return mkEvent({ url, cookies });
	}

	it('creates a session and redirects to / when binding exists and user is active', async () => {
		const u = seedUser();
		seedOAuthAccount(u.id, { provider: 'github', externalId: '42', externalUsername: 'old' });
		mocks.profile = { id: 42, login: 'newname', name: null, email: 'fresh@x' };

		const event = loginEvent();
		const r = await expectRedirect(() => GET(event as never));
		expect(r.location).toBe('/');

		// touchOAuthAccount ran — externalUsername refreshed.
		const account = mocks.testDb
			.select()
			.from(oauthAccounts)
			.where(eq(oauthAccounts.externalId, '42'))
			.get()!;
		expect(account.externalUsername).toBe('newname');
		expect(account.externalEmail).toBe('fresh@x');
	});

	it('refuses with setup_required when no users exist at all', async () => {
		mocks.profile = { id: 1, login: 'a', name: null, email: null };
		const event = loginEvent();

		const r = await expectRedirect(() => GET(event as never));
		expect(r.location).toBe('/login?error=setup_required');
	});

	it('refuses with provider_not_bound when user exists but no binding matches', async () => {
		const u = seedUser();
		seedOAuthAccount(u.id, { provider: 'github', externalId: '111' });
		mocks.profile = { id: 999, login: 'stranger', name: null, email: null };

		const event = loginEvent();
		const r = await expectRedirect(() => GET(event as never));
		expect(r.location).toBe('/login?error=provider_not_bound');
	});

	it('refuses with not_authorized when the bound user is disabled', async () => {
		const u = seedUser();
		seedOAuthAccount(u.id, { provider: 'github', externalId: '42' });
		mocks.testDb.update(users).set({ disabledAt: 1 }).where(eq(users.id, u.id)).run();
		mocks.profile = { id: 42, login: 'a', name: null, email: null };

		const event = loginEvent();
		const r = await expectRedirect(() => GET(event as never));
		expect(r.location).toBe('/login?error=not_authorized');
	});

	it('refuses with invalid_oauth_state when state mismatches', async () => {
		const event = loginEvent({ state: 'right' });
		event.url = fakeUrl({ code: 'c', state: 'wrong' });

		const r = await expectRedirect(() => GET(event as never));
		expect(r.location).toBe('/login?error=invalid_oauth_state');
	});
});

// --- Branch detection -----------------------------------------------------

describe('GitHub callback — branch detection precedence', () => {
	it('treats setup-carry as winning over link-state when both are set', async () => {
		// Setup-carry presence means we're mid-setup; if a link-state
		// happens to also be lingering from an aborted earlier flow, it
		// shouldn't divert. (The two are mutually exclusive in normal
		// use; this nails down the precedence.)
		const carry = sign({ displayName: 'Op', email: null }, 600_000);
		const { cookies } = fakeCookies({
			[SETUP_GITHUB_CARRY_COOKIE]: carry,
			[LINK_STATE_COOKIE]: 'leftover',
			[STATE_COOKIE]: 'setup-state',
		});
		const event = mkEvent({
			url: fakeUrl({ code: 'c', state: 'setup-state' }),
			cookies,
		});
		mocks.profile = { id: 1, login: 'a', name: null, email: null };

		const r = await expectRedirect(() => GET(event as never));
		// Setup branch redirects to / after creating the user.
		expect(r.location).toBe('/');
		expect(mocks.testDb.select().from(users).all()).toHaveLength(1);
	});
});
