/**
 * Provider-agnostic contract for an OAuth identity provider. Each
 * provider module (`github.ts`, `google.ts`, `oidc.ts`) exports one
 * `OAuthProvider`; the registry maps id → provider and the shared
 * start-routes + callback handler operate purely against this interface,
 * so adding the Nth provider is a new module + a registry entry — no
 * route or UI changes.
 */

/**
 * Normalized profile every provider's `fetchProfile` returns. All fields
 * are strings (or null) regardless of upstream shape: GitHub's numeric id
 * is stringified, Google/OIDC use the `sub` claim. `username` is a display
 * handle (may be null — Google has no handle, so it falls back to email or
 * name); `externalId` is the stable, unspoofable key stored in
 * `oauth_accounts.external_id`.
 */
export interface OAuthProfile {
	externalId: string;
	username: string | null;
	email: string | null;
	name: string | null;
}

/**
 * The result of building an authorization URL. `codeVerifier` is null for
 * non-PKCE providers (GitHub) and a generated secret for PKCE providers
 * (Google, OIDC) — the start route stashes it in CODE_VERIFIER_COOKIE and
 * the callback passes it back to `fetchProfile`.
 */
export interface AuthorizationRequest {
	url: URL;
	state: string;
	codeVerifier: string | null;
}

export interface OAuthProvider {
	/** Stable id; also the URL segment (`/api/auth/oauth/<id>/...`) and the
	 *  value stored in `oauth_accounts.provider`. */
	readonly id: string;

	/** Human-facing button / settings label. A function (not a constant) so
	 *  the OIDC provider can return its operator-configured display name. */
	label(): string;

	/** Whether this provider should surface a button: its `*_LOGIN_ENABLED`
	 *  flag is on AND its credentials are configured. */
	enabled(): boolean;

	/** The path the IdP redirects back to. GitHub keeps its legacy
	 *  `/api/auth/github/callback` for back-compat; others use
	 *  `/api/auth/oauth/<id>/callback`. The redirect URI registered with the
	 *  IdP is `publicBaseUrl() + callbackPath`. */
	readonly callbackPath: string;

	/** Build the provider authorization URL + state (+ PKCE verifier).
	 *  Async so OIDC can lazily fetch & cache its discovery document. */
	createAuthorizationURL(): Promise<AuthorizationRequest>;

	/** Exchange the authorization code for the user's normalized profile.
	 *  `codeVerifier` is whatever `createAuthorizationURL` returned (null for
	 *  non-PKCE providers). Throws on any upstream failure. */
	fetchProfile(code: string, codeVerifier: string | null): Promise<OAuthProfile>;
}
