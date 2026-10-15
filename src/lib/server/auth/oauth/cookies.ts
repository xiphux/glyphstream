/**
 * Cookie names shared across every OAuth provider's flow. These were
 * GitHub-specific (`STATE_COOKIE` etc. lived in `auth/github.ts`) before
 * the registry refactor; they're provider-shared now because the four
 * flows (login / setup / join / link) are identical across providers and
 * mutually exclusive within a single browser round-trip.
 *
 * The matching `start` endpoint writes the cookie; the callback reads it
 * back to defend against CSRF — the two MUST agree, so each name lives
 * here once and is imported by both rather than being two string literals
 * a typo could silently desync. (Route `+server.ts` files can't export
 * shared constants — SvelteKit validates their exports against a fixed
 * list — which is why these live in a plain lib module.)
 */
import type { Cookies } from '@sveltejs/kit';
import { setCarryCookie } from '../signed-cookies';
import type { OAuthProvider } from './types';

/**
 * Carries the OAuth `state` value between the login/setup/join redirect
 * and the callback. The login flow uses this one alone; setup/join pair
 * it with their signed carry cookie.
 */
export const STATE_COOKIE = 'glyphstream_oauth_state';

/**
 * Distinct state cookie for the *link* flow (Settings → Security →
 * "Link …"). Separating it from the login STATE_COOKIE means a tab in the
 * middle of a login flow can't be confused for a link flow if the
 * callback URLs are ever crossed.
 */
export const LINK_STATE_COOKIE = 'glyphstream_oauth_link_state';

/**
 * Carries the PKCE code verifier between the authorization redirect and
 * the callback, for providers that use PKCE (Google, generic OIDC).
 * GitHub doesn't use PKCE and never sets this. A single shared cookie is
 * safe: the four flows are mutually exclusive per round-trip, and CSRF
 * binding already comes from the per-flow state cookie above — the
 * verifier is only meaningful paired with the matching code+state. It
 * needs no HMAC signing (it's a high-entropy secret, not attacker-shaped
 * data; tampering merely makes the token exchange fail).
 */
export const CODE_VERIFIER_COOKIE = 'glyphstream_oauth_code_verifier';

/** How long the user has to complete the provider round-trip before the
 *  OAuth state / verifier cookies expire. */
export const STATE_TTL_SECONDS = 600;

/**
 * Start an OAuth round-trip: ask the provider for its authorization URL, and
 * set the state cookie the callback will check (`stateCookie`: the login/setup/
 * join one, or the link one) plus the PKCE verifier for providers that use it.
 * Both expire with the round-trip. Returns the URL to send the browser to.
 */
export async function beginAuthorization(
	provider: OAuthProvider,
	cookies: Cookies,
	stateCookie: typeof STATE_COOKIE | typeof LINK_STATE_COOKIE,
): Promise<URL> {
	const { url, state, codeVerifier } = await provider.createAuthorizationURL();
	setCarryCookie(cookies, stateCookie, state, STATE_TTL_SECONDS);
	if (codeVerifier) setCarryCookie(cookies, CODE_VERIFIER_COOKIE, codeVerifier, STATE_TTL_SECONDS);
	return url;
}
