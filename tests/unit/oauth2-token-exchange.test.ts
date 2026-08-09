/**
 * Tests for the hand-rolled OAuth2 primitives that replaced `arctic`.
 *
 * These exist because the arctic-shaped code they succeed had NO coverage:
 * the provider tests mocked the library wholesale, so nothing checked the
 * token request's body, its client-auth header, or how error responses were
 * classified. Those are exactly the things that break silently — a wrong
 * credential placement fails only against certain IdPs, and a mishandled
 * error body turns a rejected login into a confusing 500.
 *
 * The behaviours pinned here are contracts with real authorization servers,
 * not implementation details. Changing one means changing what some
 * operator's IdP sees.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	OAuth2RequestError,
	OAuth2ResponseError,
	buildAuthorizationURL,
	createS256CodeChallenge,
	decodeIdToken,
	exchangeAuthorizationCode,
	generateCodeVerifier,
	generateState,
} from '$lib/server/auth/oauth/oauth2';

const TOKEN_URL = 'https://idp.example.com/token';

const originalFetch = globalThis.fetch;

/**
 * The outgoing token request, decoded. Captured as Headers/URLSearchParams
 * rather than the raw RequestInit so assertions never stringify a
 * `BodyInit` union — the module under test always sends a string body, and
 * anything else here should fail loudly rather than become "[object Object]".
 */
let sent: { headers: Headers; body: URLSearchParams } | undefined;

/** Stub the token endpoint with a fixed status + body. */
function stubToken(status: number, body: unknown) {
	globalThis.fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
		if (typeof init?.body !== 'string') {
			throw new Error(`expected a string request body, got ${typeof init?.body}`);
		}
		sent = { headers: new Headers(init.headers), body: new URLSearchParams(init.body) };
		return Promise.resolve(
			new Response(typeof body === 'string' ? body : JSON.stringify(body), {
				status,
				headers: { 'Content-Type': 'application/json' },
			}),
		);
	}) as unknown as typeof fetch;
}

/** The captured request, asserting one was actually made. */
function sentRequest() {
	if (!sent) throw new Error('no token request was made');
	return sent;
}

const baseParams = {
	tokenEndpoint: TOKEN_URL,
	clientId: 'client-id',
	clientSecret: 'client-secret',
	redirectUri: 'https://app.example.com/callback',
	code: 'auth-code',
};

beforeEach(() => {
	sent = undefined;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe('random secrets', () => {
	it('generates distinct, high-entropy state and verifier values', () => {
		const values = new Set([
			generateState(),
			generateState(),
			generateCodeVerifier(),
			generateCodeVerifier(),
		]);
		expect(values.size).toBe(4);
		// 32 bytes base64url == 43 chars, and must be URL-safe (no +/=).
		for (const v of values) {
			expect(v).toHaveLength(43);
			expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
		}
	});

	it('derives the PKCE challenge as unpadded base64url SHA-256', () => {
		// RFC 7636 Appendix B's published test vector.
		expect(createS256CodeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
			'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
		);
	});
});

describe('buildAuthorizationURL', () => {
	it('includes a PKCE challenge only when a verifier is supplied', () => {
		const withPkce = buildAuthorizationURL({
			authorizationEndpoint: 'https://idp.example.com/authorize',
			clientId: 'cid',
			redirectUri: 'https://app.example.com/cb',
			state: 'st',
			scopes: ['openid', 'email'],
			codeVerifier: 'verifier',
		});
		expect(withPkce.searchParams.get('code_challenge_method')).toBe('S256');
		expect(withPkce.searchParams.get('code_challenge')).toBe(createS256CodeChallenge('verifier'));
		// Scopes are a space-delimited list, per RFC 6749.
		expect(withPkce.searchParams.get('scope')).toBe('openid email');
		expect(withPkce.searchParams.get('response_type')).toBe('code');

		const withoutPkce = buildAuthorizationURL({
			authorizationEndpoint: 'https://github.com/login/oauth/authorize',
			clientId: 'cid',
			redirectUri: 'https://app.example.com/cb',
			state: 'st',
			scopes: [],
		});
		expect(withoutPkce.searchParams.has('code_challenge')).toBe(false);
		expect(withoutPkce.searchParams.has('code_challenge_method')).toBe(false);
		// An empty scope list is omitted rather than sent as an empty string.
		expect(withoutPkce.searchParams.has('scope')).toBe(false);
	});

	it('preserves query parameters already on the authorization endpoint', () => {
		// Entra and some Keycloak realms hand out endpoints carrying their own
		// query string; clobbering it would break those tenants.
		const url = buildAuthorizationURL({
			authorizationEndpoint: 'https://idp.example.com/authorize?tenant=acme',
			clientId: 'cid',
			redirectUri: 'https://app.example.com/cb',
			state: 'st',
			scopes: ['openid'],
		});
		expect(url.searchParams.get('tenant')).toBe('acme');
		expect(url.searchParams.get('client_id')).toBe('cid');
	});
});

describe('exchangeAuthorizationCode — request shape', () => {
	it('sends client credentials as HTTP Basic and keeps client_id out of the body', async () => {
		stubToken(200, { access_token: 'at' });
		await exchangeAuthorizationCode({ ...baseParams, codeVerifier: 'verifier' });

		const { headers, body } = sentRequest();
		expect(headers.get('Authorization')).toBe(
			`Basic ${Buffer.from('client-id:client-secret').toString('base64')}`,
		);
		expect(headers.get('Content-Type')).toBe('application/x-www-form-urlencoded');
		expect(headers.get('Accept')).toBe('application/json');
		// GitHub rejects requests with no User-Agent.
		expect(headers.get('User-Agent')).toBeTruthy();
		expect(body.get('grant_type')).toBe('authorization_code');
		expect(body.get('code')).toBe('auth-code');
		expect(body.get('code_verifier')).toBe('verifier');
		expect(body.get('redirect_uri')).toBe('https://app.example.com/callback');
		expect(body.get('client_id')).toBeNull();
	});

	it('falls back to client_id in the body for a public client with no secret', async () => {
		stubToken(200, { access_token: 'at' });
		await exchangeAuthorizationCode({ ...baseParams, clientSecret: '' });

		const { headers, body } = sentRequest();
		expect(headers.has('Authorization')).toBe(false);
		expect(body.get('client_id')).toBe('client-id');
	});

	it('omits code_verifier entirely for non-PKCE providers', async () => {
		stubToken(200, { access_token: 'at' });
		await exchangeAuthorizationCode(baseParams);
		expect(sentRequest().body.has('code_verifier')).toBe(false);
	});
});

describe('exchangeAuthorizationCode — error classification', () => {
	/**
	 * The reason this module checks `error` on every status instead of
	 * branching on the status code. GitHub answers a bad code with HTTP 200
	 * and an error body; reading the status alone would treat that as a
	 * successful login and fail later with "missing access_token".
	 */
	it('treats a 200 carrying an `error` field as a request error (the GitHub shape)', async () => {
		stubToken(200, { error: 'bad_verification_code', error_description: 'expired' });
		const err = await exchangeAuthorizationCode(baseParams).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(OAuth2RequestError);
		expect((err as OAuth2RequestError).code).toBe('bad_verification_code');
		expect((err as OAuth2RequestError).description).toBe('expired');
	});

	it('maps a spec-compliant 400 error document to the same error type', async () => {
		stubToken(400, { error: 'invalid_grant', error_description: 'code already used' });
		const err = await exchangeAuthorizationCode(baseParams).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(OAuth2RequestError);
		expect((err as OAuth2RequestError).code).toBe('invalid_grant');
	});

	/**
	 * The callback handler branches on OAuth2RequestError to choose between
	 * "the provider rejected this" and "the provider is broken". Server faults
	 * must not be reported to the user as a rejected login.
	 */
	it('does NOT classify a 500 as a request error', async () => {
		stubToken(500, { error: 'server_error' });
		const err = await exchangeAuthorizationCode(baseParams).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(OAuth2ResponseError);
		expect(err).not.toBeInstanceOf(OAuth2RequestError);
	});

	it('rejects a non-JSON body rather than surfacing it as a token', async () => {
		stubToken(200, '<html>gateway timeout</html>');
		await expect(exchangeAuthorizationCode(baseParams)).rejects.toBeInstanceOf(OAuth2ResponseError);
	});

	it('rejects a 401 with no usable error field', async () => {
		stubToken(401, { message: 'nope' });
		await expect(exchangeAuthorizationCode(baseParams)).rejects.toBeInstanceOf(OAuth2ResponseError);
	});

	it('throws a readable error when a 200 response omits the token', async () => {
		stubToken(200, { token_type: 'Bearer' });
		const tokens = await exchangeAuthorizationCode(baseParams);
		expect(() => tokens.accessToken()).toThrow(/access_token/);
		expect(() => tokens.idToken()).toThrow(/id_token/);
	});
});

describe('decodeIdToken', () => {
	function jwt(payload: unknown): string {
		const seg = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
		return `${seg({ alg: 'RS256' })}.${seg(payload)}.sig`;
	}

	it('returns the payload claims', () => {
		expect(decodeIdToken(jwt({ sub: 'abc', email: 'a@example.com' }))).toEqual({
			sub: 'abc',
			email: 'a@example.com',
		});
	});

	it('handles unpadded base64url payloads and non-ASCII claims', () => {
		// Real ID tokens are unpadded; a decoder assuming padding breaks on
		// payload lengths that aren't a multiple of 4.
		const decoded = decodeIdToken(jwt({ sub: 'x', name: 'Ada Lovelace ✨' }));
		expect(decoded.name).toBe('Ada Lovelace ✨');
	});

	it('rejects a token that is not three segments', () => {
		expect(() => decodeIdToken('only.two')).toThrow(/three/i);
	});

	it('rejects a payload that is not a JSON object', () => {
		const seg = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
		expect(() => decodeIdToken(`${seg('{}')}.${seg('"a string"')}.sig`)).toThrow(/object/i);
		expect(() => decodeIdToken(`${seg('{}')}.${seg('not json')}.sig`)).toThrow(/JSON/i);
	});
});
