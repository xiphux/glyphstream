/**
 * Profile-normalization tests for the Google + generic-OIDC providers.
 * Both derive their normalized profile from the ID token's claims; these
 * lock the claim → {externalId, username, email, name} mapping (including
 * the username fallback chain) and that both providers carry a PKCE code
 * verifier through `createAuthorizationURL`.
 *
 * Only `$lib/server/env` and `fetch` are stubbed. This deliberately does
 * NOT mock the OAuth2 layer: it used to mock `arctic` wholesale, which
 * meant the token exchange — the request body, the client-auth header, the
 * ID-token decode — was the one part of the login path with no coverage at
 * all. Stubbing at the network boundary instead exercises the real request
 * construction, so `oauth2-token-exchange.test.ts` and this file together
 * cover what the mock used to hide.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/env', () => ({
	publicBaseUrl: () => 'http://localhost:5173',
	googleClientId: () => 'g-id',
	googleClientSecret: () => 'g-sec',
	googleLoginEnabled: () => true,
	hasGoogleCredentials: () => true,
	oidcIssuer: () => 'https://issuer.example.com',
	oidcClientId: () => 'o-id',
	oidcClientSecret: () => 'o-sec',
	oidcLoginEnabled: () => true,
	hasOidcCredentials: () => true,
	oidcDisplayName: () => 'Company SSO',
	oidcScopes: () => ['openid', 'profile', 'email'],
}));

import { googleProvider } from '$lib/server/auth/oauth/google';
import { oidcProvider } from '$lib/server/auth/oauth/oidc';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const OIDC_TOKEN_URL = 'https://issuer.example.com/token';

/**
 * A structurally valid JWT whose signature is nonsense — the providers
 * decode the payload without verifying (the token arrives over TLS
 * straight from the token endpoint), so that's all these need to be.
 */
function makeIdToken(claims: Record<string, unknown>): string {
	const seg = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
	return `${seg({ alg: 'RS256', typ: 'JWT' })}.${seg(claims)}.not-a-real-signature`;
}

const originalFetch = globalThis.fetch;

/**
 * Every fetch the providers made, in order, for request-shape assertions.
 * The body is decoded at capture time: the providers only ever send string
 * bodies, and stringifying the raw `BodyInit` union would silently yield
 * "[object Object]" if that ever stopped being true.
 */
let calls: Array<{ url: string; headers: Headers; body: URLSearchParams }>;
/** Claims baked into the id_token the stubbed token endpoint returns. */
let claims: Record<string, unknown>;

beforeEach(() => {
	calls = [];
	claims = {};
	globalThis.fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
		const url = input instanceof Request ? input.url : String(input);
		if (init?.body !== undefined && typeof init.body !== 'string') {
			throw new Error(`expected a string request body, got ${typeof init.body}`);
		}
		calls.push({
			url,
			headers: new Headers(init?.headers),
			body: new URLSearchParams(init?.body ?? ''),
		});
		if (url.endsWith('/.well-known/openid-configuration')) {
			return Promise.resolve(
				Response.json({
					authorization_endpoint: 'https://issuer.example.com/authorize',
					token_endpoint: OIDC_TOKEN_URL,
				}),
			);
		}
		if (url === GOOGLE_TOKEN_URL || url === OIDC_TOKEN_URL) {
			return Promise.resolve(
				Response.json({
					access_token: 'at',
					token_type: 'Bearer',
					id_token: makeIdToken(claims),
				}),
			);
		}
		return Promise.reject(new Error(`unexpected fetch: ${url}`));
	}) as unknown as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function tokenRequest() {
	const call = calls.find((c) => c.url === GOOGLE_TOKEN_URL || c.url === OIDC_TOKEN_URL);
	if (!call) throw new Error('no token request was made');
	return call;
}

describe('Google provider', () => {
	it('carries a PKCE code verifier and state through createAuthorizationURL', async () => {
		const req = await googleProvider.createAuthorizationURL();
		expect(req.codeVerifier).toBeTruthy();
		expect(req.state).toBeTruthy();
		// Distinct secrets, not the same value reused for both.
		expect(req.codeVerifier).not.toBe(req.state);
		expect(req.url.searchParams.get('code_challenge_method')).toBe('S256');
		// The challenge is the hash, so it must never equal the raw verifier.
		expect(req.url.searchParams.get('code_challenge')).not.toBe(req.codeVerifier);
		expect(req.url.searchParams.get('redirect_uri')).toBe(
			'http://localhost:5173/api/auth/oauth/google/callback',
		);
	});

	it('maps sub→externalId and falls back to email for the username', async () => {
		claims = { sub: 'google-123', email: 'a@example.com', name: 'Ada L' };
		const profile = await googleProvider.fetchProfile('code', 'verifier');
		expect(profile).toEqual({
			externalId: 'google-123',
			username: 'a@example.com',
			email: 'a@example.com',
			name: 'Ada L',
		});
	});

	it('sends the code verifier and Basic client credentials to the token endpoint', async () => {
		claims = { sub: 'google-123' };
		await googleProvider.fetchProfile('the-code', 'the-verifier');
		const { body, headers } = tokenRequest();
		expect(body.get('grant_type')).toBe('authorization_code');
		expect(body.get('code')).toBe('the-code');
		expect(body.get('code_verifier')).toBe('the-verifier');
		expect(body.get('redirect_uri')).toBe('http://localhost:5173/api/auth/oauth/google/callback');
		expect(headers.get('Authorization')).toBe(
			`Basic ${Buffer.from('g-id:g-sec').toString('base64')}`,
		);
		// With a secret in the header, client_id must NOT also ride in the body.
		expect(body.get('client_id')).toBeNull();
	});

	it('falls back to name for the username when email is absent', async () => {
		claims = { sub: 'google-123', name: 'Ada L' };
		const profile = await googleProvider.fetchProfile('code', 'verifier');
		expect(profile.username).toBe('Ada L');
		expect(profile.email).toBeNull();
	});

	it('throws when the ID token has no sub claim', async () => {
		claims = { email: 'a@example.com' };
		await expect(googleProvider.fetchProfile('code', 'verifier')).rejects.toThrow(/sub/);
	});

	it('throws when called without a code verifier (PKCE required)', async () => {
		await expect(googleProvider.fetchProfile('code', null)).rejects.toThrow(/verifier/i);
	});
});

describe('Generic OIDC provider', () => {
	it('prefers preferred_username, then email, then name for the username', async () => {
		claims = {
			sub: 'oidc-1',
			preferred_username: 'ada',
			email: 'a@example.com',
			name: 'Ada L',
		};
		const profile = await oidcProvider.fetchProfile('code', 'verifier');
		expect(profile).toEqual({
			externalId: 'oidc-1',
			username: 'ada',
			email: 'a@example.com',
			name: 'Ada L',
		});
	});

	it('falls back to email when preferred_username is absent', async () => {
		claims = { sub: 'oidc-1', email: 'a@example.com' };
		const profile = await oidcProvider.fetchProfile('code', 'verifier');
		expect(profile.username).toBe('a@example.com');
	});

	it('exchanges against the discovered token endpoint, not a hardcoded one', async () => {
		claims = { sub: 'oidc-1' };
		await oidcProvider.fetchProfile('code', 'verifier');
		expect(calls.some((c) => c.url === OIDC_TOKEN_URL)).toBe(true);
	});

	it('uses the operator-configured display name as its label', () => {
		expect(oidcProvider.label()).toBe('Company SSO');
	});
});
