/**
 * GET /api/auth/oauth/:provider/login — start a login-flow OAuth round-trip.
 * Sets the login STATE_COOKIE (+ the PKCE verifier cookie for providers
 * that use it) and 302-redirects to the provider. 302 (not a form POST) so
 * the CSP's `form-action 'self'` doesn't block the hop to the external IdP —
 * top-level navigations aren't policed the same way.
 */
import { error, redirect } from '@sveltejs/kit';
import { getEnabledProvider } from '#lib/server/auth/oauth/registry.js';
import { beginAuthorization, STATE_COOKIE } from '#lib/server/auth/oauth/cookies.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ cookies, params }) => {
	const provider = getEnabledProvider(params.provider);
	if (!provider) error(404, 'Unknown or disabled provider');

	const url = await beginAuthorization(provider, cookies, STATE_COOKIE);

	// SvelteKit 3 refuses a cross-origin redirect unless it's opted in, and
	// refuses by throwing — a 500. Allow exactly the provider's own origin.
	redirect(302, url.toString(), { external: [url.origin] });
};
