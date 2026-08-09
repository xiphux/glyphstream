/**
 * Minimal OAuth 2.0 / OIDC authorization-code client.
 *
 * Replaces `arctic`, which was deprecated in July 2026 with no successor —
 * its author's advice is to inline the ~200 lines you actually use, and
 * ships 0BSD-licensed reference snippets to copy. This is that inlining,
 * covering exactly the surface the three providers need (authorization
 * URL, code exchange, ID-token decode) and nothing else. It also drops
 * `@oslojs/{crypto,encoding,jwt}`, which existed only to polyfill what
 * `node:crypto` and Buffer already do.
 *
 * Server-only by construction (`$lib/server`), hence `node:crypto` rather
 * than WebCrypto — the SHA-256 is then synchronous, so building a PKCE
 * challenge doesn't need to be async.
 *
 * Scope note: this is deliberately only the authorization-code grant with
 * a confidential client. No implicit flow, no refresh, no revocation, no
 * client-credentials — none of which any provider here uses. Adding one
 * later is a few lines; carrying them unused is security surface with no
 * test coverage.
 */

import { createHash, randomBytes } from 'node:crypto';

/**
 * How long to wait on the authorization server's token endpoint. arctic
 * imposed no bound, so a black-holed IdP hung the login request until the
 * OS TCP timeout. 10s matches the OIDC discovery fetch in `oidc.ts`.
 */
const TOKEN_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Sent because GitHub rejects requests without a User-Agent. Any value
 * works; arctic sent "arctic".
 */
const USER_AGENT = 'glyphstream';

/**
 * The authorization server returned a spec-shaped error
 * (RFC 6749 §5.2) — the code was already used, the client credentials are
 * wrong, the user denied consent, and so on.
 *
 * Distinct from every other failure on purpose: the callback handler keys
 * off `instanceof` to tell "the provider said no" (surface
 * `oauth_exchange_failed` to the user) from "the provider is broken or
 * unreachable" (`upstream_failure`). Keep that distinction if you touch
 * the error types here.
 */
export class OAuth2RequestError extends Error {
	readonly code: string;
	readonly description: string | null;
	readonly uri: string | null;
	readonly state: string | null;

	constructor(
		code: string,
		description: string | null = null,
		uri: string | null = null,
		state: string | null = null,
	) {
		super(`OAuth request error: ${code}`);
		this.name = 'OAuth2RequestError';
		this.code = code;
		this.description = description;
		this.uri = uri;
		this.state = state;
	}
}

/** The token endpoint answered, but not with anything usable. */
export class OAuth2ResponseError extends Error {
	readonly status: number;

	constructor(status: number, detail: string) {
		super(`Unexpected token endpoint response (HTTP ${status}): ${detail}`);
		this.name = 'OAuth2ResponseError';
		this.status = status;
	}
}

/**
 * A successful token response. Accessors throw rather than return
 * undefined so a malformed-but-200 response fails at the point of use with
 * a readable message instead of surfacing as `undefined` three frames
 * later. Only the two fields the providers read are exposed.
 */
export class OAuth2Tokens {
	constructor(private readonly data: Record<string, unknown>) {}

	accessToken(): string {
		const v = this.data.access_token;
		if (typeof v !== 'string') throw new Error("Token response is missing 'access_token'");
		return v;
	}

	idToken(): string {
		const v = this.data.id_token;
		if (typeof v !== 'string') throw new Error("Token response is missing 'id_token'");
		return v;
	}
}

/** 32 random bytes, base64url. Used for both the CSRF state and PKCE verifier. */
function randomToken(): string {
	return randomBytes(32).toString('base64url');
}

export function generateState(): string {
	return randomToken();
}

export function generateCodeVerifier(): string {
	return randomToken();
}

/** S256 PKCE challenge: base64url(SHA-256(verifier)), unpadded. */
export function createS256CodeChallenge(codeVerifier: string): string {
	return createHash('sha256').update(codeVerifier).digest('base64url');
}

/**
 * Read the claims out of an ID token WITHOUT verifying its signature.
 *
 * That is safe here, and only here, because every caller receives the
 * token as the direct response body of a TLS request to the issuer's own
 * token endpoint — the transport authenticates it, so there is nothing a
 * signature check would add. It would NOT be safe for a token arriving via
 * the browser (an implicit/hybrid flow), which none of these providers use.
 *
 * If you ever need real verification, that means fetching and caching the
 * issuer's JWKS and handling key rotation — a materially bigger change than
 * swapping this function out. Don't half-do it.
 */
export function decodeIdToken(idToken: string): Record<string, unknown> {
	const parts = idToken.split('.');
	if (parts.length !== 3) {
		throw new Error('Invalid ID token: expected three JWT segments');
	}
	let payload: unknown;
	try {
		payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
	} catch (cause) {
		throw new Error('Invalid ID token: payload is not valid JSON', { cause });
	}
	if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
		throw new Error('Invalid ID token: payload is not a JSON object');
	}
	return payload as Record<string, unknown>;
}

export interface AuthorizationURLParams {
	authorizationEndpoint: string;
	clientId: string;
	redirectUri: string;
	state: string;
	scopes: string[];
	/** Supply to use PKCE (always S256). Omit/null for providers without it. */
	codeVerifier?: string | null;
}

export function buildAuthorizationURL(params: AuthorizationURLParams): URL {
	const url = new URL(params.authorizationEndpoint);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('client_id', params.clientId);
	url.searchParams.set('redirect_uri', params.redirectUri);
	url.searchParams.set('state', params.state);
	if (params.scopes.length > 0) {
		url.searchParams.set('scope', params.scopes.join(' '));
	}
	if (params.codeVerifier) {
		url.searchParams.set('code_challenge_method', 'S256');
		url.searchParams.set('code_challenge', createS256CodeChallenge(params.codeVerifier));
	}
	return url;
}

export interface TokenExchangeParams {
	tokenEndpoint: string;
	clientId: string;
	clientSecret: string;
	redirectUri: string;
	code: string;
	/** Must match the verifier whose challenge went out in the auth URL. */
	codeVerifier?: string | null;
}

/**
 * Exchange an authorization code for tokens.
 *
 * Client authentication deliberately mirrors what arctic did: credentials
 * go in an HTTP Basic header, and `client_id` is repeated in the body only
 * when there is no secret. Some IdPs accept only one of the two placements,
 * so this is the one thing here that must NOT be "cleaned up" — operators
 * are running Authentik/Keycloak/Authelia/Entra against it today, and a
 * change would break a subset of them silently and only in production.
 */
export async function exchangeAuthorizationCode(
	params: TokenExchangeParams,
): Promise<OAuth2Tokens> {
	const body = new URLSearchParams();
	body.set('grant_type', 'authorization_code');
	body.set('code', params.code);
	body.set('redirect_uri', params.redirectUri);
	if (params.codeVerifier) {
		body.set('code_verifier', params.codeVerifier);
	}

	const headers = new Headers({
		'Content-Type': 'application/x-www-form-urlencoded',
		Accept: 'application/json',
		'User-Agent': USER_AGENT,
	});
	if (params.clientSecret) {
		const basic = Buffer.from(`${params.clientId}:${params.clientSecret}`, 'utf8').toString(
			'base64',
		);
		headers.set('Authorization', `Basic ${basic}`);
	} else {
		body.set('client_id', params.clientId);
	}

	const response = await fetch(params.tokenEndpoint, {
		method: 'POST',
		headers,
		body: body.toString(),
		signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
	});

	// Read the body for any status that could plausibly carry an OAuth error
	// document. Everything else is an outage, not a protocol answer.
	if (response.status !== 200 && response.status !== 400 && response.status !== 401) {
		await response.body?.cancel();
		throw new OAuth2ResponseError(response.status, 'unexpected status');
	}

	let data: unknown;
	try {
		data = await response.json();
	} catch {
		throw new OAuth2ResponseError(response.status, 'body is not JSON');
	}
	if (typeof data !== 'object' || data === null || Array.isArray(data)) {
		throw new OAuth2ResponseError(response.status, 'body is not a JSON object');
	}
	const parsed = data as Record<string, unknown>;

	// Checked on 200 as well as the two error statuses, and the 200 case is
	// load-bearing: GitHub answers a failed exchange with
	// `200 {"error": "bad_verification_code"}` rather than a 4xx, which is why
	// arctic needed a whole separate GitHub code path. Testing the field
	// rather than the status covers both shapes in one branch — and a
	// spec-compliant success response can never carry `error`
	// (RFC 6749 §5.1), so there's no ambiguity to trade away.
	//
	// Statuses outside the {200, 400, 401} set above never reach here, so an
	// IdP that returns an error document under some other code (403, 429)
	// surfaces as OAuth2ResponseError — an outage — rather than a rejected
	// login. arctic's generic client drew the line in the same place, so
	// widening it is a deliberate change to make, not an oversight to fix in
	// passing.
	//
	// GitHub is the one place classification did move: arctic's GitHub-specific
	// path threw on ANY non-200 without reading the body, so a GitHub 4xx error
	// document used to reach the user as `upstream_failure` and now correctly
	// reaches it as `oauth_exchange_failed`.
	if (typeof parsed.error === 'string') {
		throw new OAuth2RequestError(
			parsed.error,
			typeof parsed.error_description === 'string' ? parsed.error_description : null,
			typeof parsed.error_uri === 'string' ? parsed.error_uri : null,
			typeof parsed.state === 'string' ? parsed.state : null,
		);
	}

	if (response.status !== 200) {
		throw new OAuth2ResponseError(response.status, 'error response without an `error` field');
	}

	return new OAuth2Tokens(parsed);
}
