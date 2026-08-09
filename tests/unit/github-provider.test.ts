/**
 * Contract tests for the GitHub OAuth provider.
 *
 * GitHub was the one provider with no coverage of its own. `github-callback.test.ts`
 * mocks the provider wholesale to exercise the callback handler, and
 * `oauth-provider-profile.test.ts` covers only Google and OIDC — so once the
 * endpoint URLs moved in-tree (they used to belong to `arctic`), nothing pinned
 * them. A typo in the token endpoint, or a regression that started sending PKCE
 * to GitHub, would break every GitHub login with a fully green suite.
 *
 * Everything here stubs at `fetch`, so the real request construction runs. Two
 * groups of assertions:
 *
 *   1. The request contract — endpoints, scopes, Basic auth, and the absence of
 *      PKCE (GitHub doesn't support it). These are what a real authorization
 *      server sees, so changing one means changing what production sends.
 *   2. Timeout behaviour — the two api.github.com calls are bounded, and the
 *      two call sites deliberately treat an abort differently: identifying the
 *      user is required, fetching their private email is not.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/env', () => ({
	publicBaseUrl: () => 'http://localhost:5173',
	githubClientId: () => 'gh-id',
	githubClientSecret: () => 'gh-sec',
	githubLoginEnabled: () => true,
	hasGithubCredentials: () => true,
}));

import { githubProvider } from '$lib/server/auth/oauth/github';

const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const USER_URL = 'https://api.github.com/user';
const EMAILS_URL = 'https://api.github.com/user/emails';
const CALLBACK_URL = 'http://localhost:5173/api/auth/github/callback';

/** How an `AbortSignal.timeout` rejection actually surfaces from fetch. */
const timeoutError = () => new DOMException('The operation timed out', 'TimeoutError');

interface Call {
	url: string;
	headers: Headers;
	body: URLSearchParams;
	hasSignal: boolean;
}

const originalFetch = globalThis.fetch;
let calls: Call[];

/**
 * Route the three URLs the provider touches. `overrides` replaces the default
 * response for a URL; a thrown/rejected value simulates a transport failure.
 */
function stubFetch(overrides: Record<string, () => Promise<Response>> = {}) {
	calls = [];
	globalThis.fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
		const url = input instanceof Request ? input.url : String(input);
		if (init?.body !== undefined && typeof init.body !== 'string') {
			throw new Error(`expected a string request body, got ${typeof init.body}`);
		}
		calls.push({
			url,
			headers: new Headers(init?.headers),
			body: new URLSearchParams(init?.body ?? ''),
			hasSignal: Boolean(init?.signal),
		});
		const override = overrides[url];
		if (override) return override();
		if (url === TOKEN_URL) return Promise.resolve(Response.json({ access_token: 'tok' }));
		if (url === USER_URL) {
			return Promise.resolve(Response.json({ id: 42, login: 'ada', name: 'Ada L', email: null }));
		}
		if (url === EMAILS_URL) return Promise.resolve(Response.json([]));
		return Promise.reject(new Error(`unexpected fetch: ${url}`));
	}) as unknown as typeof fetch;
}

function callTo(url: string): Call {
	const call = calls.find((c) => c.url === url);
	if (!call) throw new Error(`no request was made to ${url}`);
	return call;
}

beforeEach(() => {
	stubFetch();
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe('GitHub provider — authorization request', () => {
	it('builds the authorization URL against GitHub with the right scopes and no PKCE', async () => {
		const req = await githubProvider.createAuthorizationURL();
		expect(`${req.url.origin}${req.url.pathname}`).toBe(AUTHORIZE_URL);
		expect(req.url.searchParams.get('client_id')).toBe('gh-id');
		expect(req.url.searchParams.get('redirect_uri')).toBe(CALLBACK_URL);
		expect(req.url.searchParams.get('scope')).toBe('read:user user:email');
		expect(req.url.searchParams.get('state')).toBe(req.state);
		expect(req.state).toBeTruthy();
		// GitHub has no PKCE support: sending a challenge is not merely useless,
		// it's what would make the exchange fail if a shared helper ever started
		// adding one unconditionally.
		expect(req.codeVerifier).toBeNull();
		expect(req.url.searchParams.has('code_challenge')).toBe(false);
		expect(req.url.searchParams.has('code_challenge_method')).toBe(false);
	});

	it('keeps the legacy callback path so registered OAuth apps keep working', () => {
		// Operators registered this exact URL with GitHub; changing it silently
		// breaks every existing deployment.
		expect(githubProvider.callbackPath).toBe('/api/auth/github/callback');
	});
});

describe('GitHub provider — token exchange', () => {
	it('posts to GitHub with Basic credentials and no code_verifier', async () => {
		await githubProvider.fetchProfile('the-code', null);
		const { headers, body } = callTo(TOKEN_URL);
		expect(body.get('grant_type')).toBe('authorization_code');
		expect(body.get('code')).toBe('the-code');
		expect(body.get('redirect_uri')).toBe(CALLBACK_URL);
		expect(headers.get('Authorization')).toBe(
			`Basic ${Buffer.from('gh-id:gh-sec').toString('base64')}`,
		);
		expect(body.get('client_id')).toBeNull();
		expect(body.has('code_verifier')).toBe(false);
	});

	/**
	 * GitHub answers a bad code with HTTP 200 and an error body rather than a
	 * 4xx. This is the case that needed a dedicated code path in `arctic`, and
	 * the reason `exchangeAuthorizationCode` tests the field rather than the
	 * status — if that ever regressed, a failed exchange would look like a
	 * success and fail later with a confusing "missing access_token".
	 */
	it('surfaces GitHub 200-with-error as an OAuth request error, not a token', async () => {
		stubFetch({
			[TOKEN_URL]: () => Promise.resolve(Response.json({ error: 'bad_verification_code' })),
		});
		await expect(githubProvider.fetchProfile('stale-code', null)).rejects.toMatchObject({
			code: 'bad_verification_code',
		});
		// And it must not have gone on to call the profile API with no token.
		expect(calls.some((c) => c.url === USER_URL)).toBe(false);
	});
});

describe('GitHub provider — profile normalization', () => {
	it('stringifies the numeric id and uses login as the username', async () => {
		stubFetch({
			[USER_URL]: () =>
				Promise.resolve(
					Response.json({ id: 42, login: 'ada', name: 'Ada L', email: 'pub@example.com' }),
				),
		});
		const profile = await githubProvider.fetchProfile('code', null);
		expect(profile).toEqual({
			externalId: '42',
			username: 'ada',
			name: 'Ada L',
			email: 'pub@example.com',
		});
		// A public email means the second API call is skipped entirely.
		expect(calls.some((c) => c.url === EMAILS_URL)).toBe(false);
	});

	it('falls back to the verified primary address when the email is hidden', async () => {
		stubFetch({
			[EMAILS_URL]: () =>
				Promise.resolve(
					Response.json([
						{ email: 'secondary@example.com', primary: false, verified: true },
						{ email: 'unverified@example.com', primary: true, verified: false },
						{ email: 'primary@example.com', primary: true, verified: true },
					]),
				),
		});
		const profile = await githubProvider.fetchProfile('code', null);
		// Only the primary AND verified address qualifies — an unverified one is
		// attacker-controllable and must never become the account's identity.
		expect(profile.email).toBe('primary@example.com');
	});

	it('rejects a /user response missing the fields the account key depends on', async () => {
		stubFetch({ [USER_URL]: () => Promise.resolve(Response.json({ login: 'ada' })) });
		await expect(githubProvider.fetchProfile('code', null)).rejects.toThrow(/id\/login/);
	});

	it('rejects a non-OK /user response', async () => {
		stubFetch({ [USER_URL]: () => Promise.resolve(new Response('nope', { status: 500 })) });
		await expect(githubProvider.fetchProfile('code', null)).rejects.toThrow(/500/);
	});
});

describe('GitHub provider — timeouts', () => {
	it('bounds both api.github.com calls', async () => {
		await githubProvider.fetchProfile('code', null);
		expect(callTo(USER_URL).hasSignal).toBe(true);
		expect(callTo(EMAILS_URL).hasSignal).toBe(true);
	});

	it('fails the login when /user times out', async () => {
		// We cannot identify the user, so this must NOT resolve to a partial
		// profile — the callback handler turns it into `upstream_failure`.
		stubFetch({ [USER_URL]: () => Promise.reject(timeoutError()) });
		await expect(githubProvider.fetchProfile('code', null)).rejects.toThrow(/timed out/i);
	});

	it('still logs the user in when only /user/emails times out', async () => {
		// The email is optional; a slow GitHub should cost the address, not the
		// whole login.
		stubFetch({ [EMAILS_URL]: () => Promise.reject(timeoutError()) });
		const profile = await githubProvider.fetchProfile('code', null);
		expect(profile.externalId).toBe('42');
		expect(profile.email).toBeNull();
	});
});
