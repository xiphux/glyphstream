/**
 * Generic OIDC provider: the shared OAuth2 primitives plus a manual fetch
 * of the issuer's `/.well-known/openid-configuration`. Lets an operator
 * wire up any standards-compliant IdP — Authentik, Keycloak, Authelia,
 * Pocket ID, Google Workspace, Microsoft Entra — by setting OIDC_ISSUER +
 * client credentials. Uses PKCE.
 */
import {
	buildAuthorizationURL,
	decodeIdToken,
	exchangeAuthorizationCode,
	generateCodeVerifier,
	generateState,
} from './oauth2';
import {
	hasOidcCredentials,
	oidcClientId,
	oidcClientSecret,
	oidcDisplayName,
	oidcIssuer,
	oidcLoginEnabled,
	oidcScopes,
	publicBaseUrl,
} from '../../env';
import type { AuthorizationRequest, OAuthProfile, OAuthProvider } from './types';

export const OIDC_OAUTH_CALLBACK_PATH = '/api/auth/oauth/oidc/callback';

interface Discovery {
	authorizationEndpoint: string;
	tokenEndpoint: string;
}

let cachedDiscovery: Discovery | null = null;

function redirectUri(): string {
	return `${publicBaseUrl()}${OIDC_OAUTH_CALLBACK_PATH}`;
}

/**
 * Fetch + cache the issuer's discovery document for the process lifetime.
 * Issuers rarely rotate endpoints; a deploy restart re-discovers. Failure
 * throws a plain Error (the callback handler maps non-OAuth2RequestError
 * failures to `upstream_failure`).
 */
async function getDiscovery(): Promise<Discovery> {
	if (cachedDiscovery) return cachedDiscovery;
	const wellKnown = `${oidcIssuer()}/.well-known/openid-configuration`;
	// Bound the outbound fetch (house convention) so a black-holed issuer
	// fails this login attempt in seconds rather than hanging on the OS TCP
	// timeout. 10s mirrors the endpoint client's metadata-fetch budget.
	const res = await fetch(wellKnown, {
		headers: { Accept: 'application/json' },
		signal: AbortSignal.timeout(10_000),
	});
	if (!res.ok) {
		throw new Error(`OIDC discovery ${wellKnown} returned HTTP ${res.status}`);
	}
	const doc = (await res.json()) as {
		authorization_endpoint?: unknown;
		token_endpoint?: unknown;
	};
	if (typeof doc.authorization_endpoint !== 'string' || typeof doc.token_endpoint !== 'string') {
		throw new Error('OIDC discovery document missing authorization_endpoint/token_endpoint');
	}
	cachedDiscovery = {
		authorizationEndpoint: doc.authorization_endpoint,
		tokenEndpoint: doc.token_endpoint,
	};
	return cachedDiscovery;
}

function asString(v: unknown): string | null {
	return typeof v === 'string' && v.length > 0 ? v : null;
}

async function createAuthorizationURL(): Promise<AuthorizationRequest> {
	const { authorizationEndpoint } = await getDiscovery();
	const state = generateState();
	const codeVerifier = generateCodeVerifier();
	const url = buildAuthorizationURL({
		authorizationEndpoint,
		clientId: oidcClientId(),
		redirectUri: redirectUri(),
		state,
		scopes: oidcScopes(),
		codeVerifier,
	});
	return { url, state, codeVerifier };
}

async function fetchProfile(code: string, codeVerifier: string | null): Promise<OAuthProfile> {
	if (!codeVerifier) throw new Error('OIDC requires a PKCE code verifier');
	const { tokenEndpoint } = await getDiscovery();
	const tokens = await exchangeAuthorizationCode({
		tokenEndpoint,
		clientId: oidcClientId(),
		clientSecret: oidcClientSecret(),
		redirectUri: redirectUri(),
		code,
		codeVerifier,
	});
	// ID token comes straight from the token endpoint over TLS — see the note
	// on decodeIdToken for why decoding, not verifying, is sufficient here.
	const claims = decodeIdToken(tokens.idToken()) as {
		sub?: unknown;
		email?: unknown;
		name?: unknown;
		preferred_username?: unknown;
	};
	const externalId = asString(claims.sub);
	if (!externalId) throw new Error('OIDC ID token missing sub claim');
	const email = asString(claims.email);
	const name = asString(claims.name);

	return {
		externalId,
		username: asString(claims.preferred_username) ?? email ?? name,
		email,
		name,
	};
}

export const oidcProvider: OAuthProvider = {
	id: 'oidc',
	label: () => oidcDisplayName(),
	enabled: () => oidcLoginEnabled() && hasOidcCredentials(),
	callbackPath: OIDC_OAUTH_CALLBACK_PATH,
	createAuthorizationURL,
	fetchProfile,
};
