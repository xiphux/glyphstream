/**
 * Generic OIDC provider, built on arctic's low-level `OAuth2Client` plus a
 * manual fetch of the issuer's `/.well-known/openid-configuration`
 * (arctic ships no generic-OIDC discovery class). Lets an operator wire up
 * any standards-compliant IdP — Authentik, Keycloak, Authelia, Pocket ID,
 * Google Workspace, Microsoft Entra — by setting OIDC_ISSUER + client
 * credentials. Uses PKCE.
 */
import {
	CodeChallengeMethod,
	OAuth2Client,
	decodeIdToken,
	generateCodeVerifier,
	generateState,
} from 'arctic';
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

let cachedClient: OAuth2Client | null = null;
let cachedDiscovery: Discovery | null = null;

function getClient(): OAuth2Client {
	if (!cachedClient) {
		const callbackUrl = `${publicBaseUrl()}${OIDC_OAUTH_CALLBACK_PATH}`;
		cachedClient = new OAuth2Client(oidcClientId(), oidcClientSecret(), callbackUrl);
	}
	return cachedClient;
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
	const url = getClient().createAuthorizationURLWithPKCE(
		authorizationEndpoint,
		state,
		CodeChallengeMethod.S256,
		codeVerifier,
		oidcScopes(),
	);
	return { url, state, codeVerifier };
}

async function fetchProfile(code: string, codeVerifier: string | null): Promise<OAuthProfile> {
	if (!codeVerifier) throw new Error('OIDC requires a PKCE code verifier');
	const { tokenEndpoint } = await getDiscovery();
	const tokens = await getClient().validateAuthorizationCode(tokenEndpoint, code, codeVerifier);
	// ID token comes straight from the token endpoint over TLS — decode the
	// claims (the standard arctic pattern for the code flow).
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
