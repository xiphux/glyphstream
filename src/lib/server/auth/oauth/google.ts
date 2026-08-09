/**
 * Google OAuth provider. Uses PKCE, so it generates a code verifier in
 * `createAuthorizationURL` and consumes it in `fetchProfile`. The profile
 * comes from the ID token's claims — Google returns one whenever the
 * `openid` scope is requested, so no separate userinfo call is needed.
 */
import {
	buildAuthorizationURL,
	decodeIdToken,
	exchangeAuthorizationCode,
	generateCodeVerifier,
	generateState,
} from './oauth2';
import {
	googleClientId,
	googleClientSecret,
	googleLoginEnabled,
	hasGoogleCredentials,
	publicBaseUrl,
} from '../../env';
import type { AuthorizationRequest, OAuthProfile, OAuthProvider } from './types';

export const GOOGLE_OAUTH_CALLBACK_PATH = '/api/auth/oauth/google/callback';
const GOOGLE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_SCOPES = ['openid', 'profile', 'email'];

function redirectUri(): string {
	return `${publicBaseUrl()}${GOOGLE_OAUTH_CALLBACK_PATH}`;
}

function asString(v: unknown): string | null {
	return typeof v === 'string' && v.length > 0 ? v : null;
}

async function fetchProfile(code: string, codeVerifier: string | null): Promise<OAuthProfile> {
	if (!codeVerifier) throw new Error('Google OAuth requires a PKCE code verifier');
	const tokens = await exchangeAuthorizationCode({
		tokenEndpoint: GOOGLE_TOKEN_ENDPOINT,
		clientId: googleClientId(),
		clientSecret: googleClientSecret(),
		redirectUri: redirectUri(),
		code,
		codeVerifier,
	});
	// The ID token arrives directly from Google's token endpoint over TLS —
	// see the note on decodeIdToken for why that makes decoding sufficient.
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
		const url = buildAuthorizationURL({
			authorizationEndpoint: GOOGLE_AUTHORIZATION_ENDPOINT,
			clientId: googleClientId(),
			redirectUri: redirectUri(),
			state,
			scopes: GOOGLE_SCOPES,
			codeVerifier,
		});
		return Promise.resolve({ url, state, codeVerifier });
	},
	fetchProfile,
};
