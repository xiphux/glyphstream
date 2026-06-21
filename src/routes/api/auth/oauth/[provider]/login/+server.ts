/**
 * GET /api/auth/oauth/:provider/login — start a login-flow OAuth round-trip.
 * Sets the login STATE_COOKIE (+ the PKCE verifier cookie for providers
 * that use it) and 302-redirects to the provider. 302 (not a form POST) so
 * the CSP's `form-action 'self'` doesn't block the hop to the external IdP —
 * top-level navigations aren't policed the same way.
 */
import { error, redirect } from '@sveltejs/kit';
import { getEnabledProvider } from '$lib/server/auth/oauth/registry';
import {
	CODE_VERIFIER_COOKIE,
	STATE_COOKIE,
	STATE_TTL_SECONDS,
} from '$lib/server/auth/oauth/cookies';
import { setCarryCookie } from '$lib/server/auth/signed-cookies';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ cookies, params }) => {
	const provider = getEnabledProvider(params.provider);
	if (!provider) throw error(404, 'Unknown or disabled provider');

	const { url, state, codeVerifier } = await provider.createAuthorizationURL();
	setCarryCookie(cookies, STATE_COOKIE, state, STATE_TTL_SECONDS);
	if (codeVerifier) setCarryCookie(cookies, CODE_VERIFIER_COOKIE, codeVerifier, STATE_TTL_SECONDS);

	throw redirect(302, url.toString());
};
