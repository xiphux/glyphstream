/**
 * GET /api/auth/oauth/:provider/link/start — kick off a session-attached
 * OAuth round-trip whose callback binds the resulting profile to the
 * *current* user (rather than looking up an existing binding). Uses a
 * separate state cookie from the login flow so a tab swap can't confuse the
 * two paths.
 *
 * GET so the settings page can link to it via a plain anchor —
 * `<form method="POST">` would be blocked by the CSP's `form-action 'self'`
 * directive, since the start endpoint ultimately redirects to the external
 * IdP. Top-level navigations (from `<a href>` or `window.location.href`)
 * aren't restricted by CSP.
 */
import { error, redirect } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import { getEnabledProvider } from '$lib/server/auth/oauth/registry';
import {
	CODE_VERIFIER_COOKIE,
	LINK_STATE_COOKIE,
	STATE_TTL_SECONDS,
} from '$lib/server/auth/oauth/cookies';
import { setCarryCookie } from '$lib/server/auth/signed-cookies';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, cookies, params }) => {
	requireUser(locals);
	const provider = getEnabledProvider(params.provider);
	if (!provider) throw error(404, 'Unknown or disabled provider');

	const { url, state, codeVerifier } = await provider.createAuthorizationURL();
	setCarryCookie(cookies, LINK_STATE_COOKIE, state, STATE_TTL_SECONDS);
	if (codeVerifier) setCarryCookie(cookies, CODE_VERIFIER_COOKIE, codeVerifier, STATE_TTL_SECONDS);

	throw redirect(302, url.toString());
};
