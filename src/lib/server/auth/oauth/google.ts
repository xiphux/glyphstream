/**
 * Google OAuth provider. Uses PKCE (required by arctic's `Google`), so it
 * generates a code verifier in `createAuthorizationURL` and consumes it in
 * `fetchProfile`. The profile comes from the ID token's claims — Google
 * returns one whenever the `openid` scope is requested, so no separate
 * userinfo call is needed.
 */
import { Google, decodeIdToken, generateCodeVerifier, generateState } from 'arctic';
import {
	googleClientId,
	googleClientSecret,
	googleLoginEnabled,
	hasGoogleCredentials,
	publicBaseUrl,
} from '../../env';
import type { AuthorizationRequest, OAuthProfile, OAuthProvider } from './types';

export const GOOGLE_OAUTH_CALLBACK_PATH = '/api/auth/oauth/google/callback';
const GOOGLE_SCOPES = ['openid', 'profile', 'email'];

let cached: Google | null = null;

function getClient(): Google {
	if (!cached) {
		const callbackUrl = `${publicBaseUrl()}${GOOGLE_OAUTH_CALLBACK_PATH}`;
		cached = new Google(googleClientId(), googleClientSecret(), callbackUrl);
	}
	return cached;
}

function asString(v: unknown): string | null {
	return typeof v === 'string' && v.length > 0 ? v : null;
}

async function fetchProfile(code: string, codeVerifier: string | null): Promise<OAuthProfile> {
	if (!codeVerifier) throw new Error('Google OAuth requires a PKCE code verifier');
	const tokens = await getClient().validateAuthorizationCode(code, codeVerifier);
	// The ID token arrives directly from Google's token endpoint over TLS,
	// so decoding (not verifying) the claims is the standard arctic pattern.
	const claims = decodeIdToken(tokens.idToken()) as {
		sub?: unknown;
		email?: unknown;
		name?: unknown;
	};
	const externalId = asString(claims.sub);
	if (!externalId) throw new Error('Google ID token missing sub claim');
	const email = asString(claims.email);
	const name = asString(claims.name);

	return {
		externalId,
		// Google has no "handle" — fall back to email, then name, for display.
		username: email ?? name,
		email,
		name,
	};
}

export const googleProvider: OAuthProvider = {
	id: 'google',
	label: () => 'Google',
	enabled: () => googleLoginEnabled() && hasGoogleCredentials(),
	callbackPath: GOOGLE_OAUTH_CALLBACK_PATH,
	createAuthorizationURL(): Promise<AuthorizationRequest> {
		const state = generateState();
		const codeVerifier = generateCodeVerifier();
		const url = getClient().createAuthorizationURL(state, codeVerifier, GOOGLE_SCOPES);
		return Promise.resolve({ url, state, codeVerifier });
	},
	fetchProfile,
};
