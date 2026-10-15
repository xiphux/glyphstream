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
import { requireUser } from '#lib/server/auth/guard.js';
import { getEnabledProvider } from '#lib/server/auth/oauth/registry.js';
import { beginAuthorization, LINK_STATE_COOKIE } from '#lib/server/auth/oauth/cookies.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, cookies, params }) => {
	requireUser(locals);
	const provider = getEnabledProvider(params.provider);
	if (!provider) error(404, 'Unknown or disabled provider');

	const url = await beginAuthorization(provider, cookies, LINK_STATE_COOKIE);

	// SvelteKit 3 refuses a cross-origin redirect unless it's opted in, and
	// refuses by throwing — a 500. Allow exactly the provider's own origin.
	redirect(302, url.toString(), { external: [url.origin] });
};
