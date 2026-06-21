/**
 * Profile-normalization tests for the Google + generic-OIDC providers.
 * Both derive their normalized profile from the ID token's claims; these
 * lock the claim → {externalId, username, email, name} mapping (including
 * the username fallback chain) and that both providers carry a PKCE code
 * verifier through `createAuthorizationURL`. `arctic` and `$lib/server/env`
 * are mocked so no network or real credentials are involved.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tokenState = vi.hoisted(() => ({ claims: {} as Record<string, unknown> }));

vi.mock('arctic', () => {
	class Google {
		createAuthorizationURL() {
			return new URL('https://accounts.google.com/o/oauth2/v2/auth');
		}
		async validateAuthorizationCode() {
			return { idToken: () => 'fake.id.token' };
		}
	}
	class OAuth2Client {
		createAuthorizationURLWithPKCE() {
			return new URL('https://issuer.example.com/authorize');
		}
		async validateAuthorizationCode() {
			return { idToken: () => 'fake.id.token' };
		}
	}
	return {
		Google,
		OAuth2Client,
		CodeChallengeMethod: { S256: 0, Plain: 1 },
		generateState: () => 'test-state',
		generateCodeVerifier: () => 'test-verifier',
		decodeIdToken: () => tokenState.claims,
	};
});

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

const originalFetch = globalThis.fetch;

beforeEach(() => {
	tokenState.claims = {};
	// OIDC discovery fetch — returns the well-known endpoints.
	globalThis.fetch = vi.fn(async () =>
		Response.json({
			authorization_endpoint: 'https://issuer.example.com/authorize',
			token_endpoint: 'https://issuer.example.com/token',
		}),
	) as unknown as typeof fetch;
});

describe('Google provider', () => {
	it('carries a PKCE code verifier through createAuthorizationURL', async () => {
		const req = await googleProvider.createAuthorizationURL();
		expect(req.codeVerifier).toBe('test-verifier');
		expect(req.state).toBe('test-state');
	});

	it('maps sub→externalId and falls back to email for the username', async () => {
		tokenState.claims = { sub: 'google-123', email: 'a@example.com', name: 'Ada L' };
		const profile = await googleProvider.fetchProfile('code', 'verifier');
		expect(profile).toEqual({
			externalId: 'google-123',
			username: 'a@example.com',
			email: 'a@example.com',
			name: 'Ada L',
		});
	});

	it('falls back to name for the username when email is absent', async () => {
		tokenState.claims = { sub: 'google-123', name: 'Ada L' };
		const profile = await googleProvider.fetchProfile('code', 'verifier');
		expect(profile.username).toBe('Ada L');
		expect(profile.email).toBeNull();
	});

	it('throws when the ID token has no sub claim', async () => {
		tokenState.claims = { email: 'a@example.com' };
		await expect(googleProvider.fetchProfile('code', 'verifier')).rejects.toThrow(/sub/);
	});

	it('throws when called without a code verifier (PKCE required)', async () => {
		await expect(googleProvider.fetchProfile('code', null)).rejects.toThrow(/verifier/i);
	});
});

describe('Generic OIDC provider', () => {
	it('prefers preferred_username, then email, then name for the username', async () => {
		tokenState.claims = {
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
		tokenState.claims = { sub: 'oidc-1', email: 'a@example.com' };
		const profile = await oidcProvider.fetchProfile('code', 'verifier');
		expect(profile.username).toBe('a@example.com');
	});

	it('uses the operator-configured display name as its label', () => {
		expect(oidcProvider.label()).toBe('Company SSO');
	});
});

// Restore the global fetch so this file doesn't leak its mock.
afterEach(() => {
	globalThis.fetch = originalFetch;
});
