/**
 * POST /api/auth/oauth/:provider/setup/start — kick off the OAuth round-
 * trip for the first-run wizard. Validates the setup gate (count must still
 * be zero, token must match if SETUP_TOKEN is set), captures the operator-
 * supplied display name + email in a signed carry cookie, and returns the
 * authorization URL.
 *
 * Returns JSON `{ url }` rather than a 302 so the client can drive the
 * navigation via `window.location.href`. A `<form method="POST">` would be
 * cleaner but the CSP's `form-action 'self'` rejects form submissions
 * ending at the external IdP. Top-level navigations (anchor clicks,
 * `window.location.href` assignment) aren't policed the same way.
 */
import { error, json } from '@sveltejs/kit';
import { getEnabledProvider } from '$lib/server/auth/oauth/registry';
import {
	CODE_VERIFIER_COOKIE,
	STATE_COOKIE,
	STATE_TTL_SECONDS,
} from '$lib/server/auth/oauth/cookies';
import { SETUP_OAUTH_CARRY_COOKIE, setupGate } from '$lib/server/auth/setup';
import { sign, setCarryCookie } from '$lib/server/auth/signed-cookies';
import { parseIdentityInput } from '$lib/server/auth/identity-input';
import { parseJsonBody } from '$lib/server/http';
import type { RequestHandler } from './$types';

const CARRY_TTL_MS = STATE_TTL_SECONDS * 1000;

export const POST: RequestHandler = async ({ request, cookies, url, params }) => {
	const provider = getEnabledProvider(params.provider);
	if (!provider) throw error(404, 'Unknown or disabled provider');
	const verdict = setupGate(url);
	if (verdict !== 'allowed') throw error(403, 'Setup is not currently allowed');

	const { displayName, email } = parseIdentityInput(
		await parseJsonBody<{ displayName?: unknown; email?: unknown }>(request),
	);

	const { url: oauthUrl, state, codeVerifier } = await provider.createAuthorizationURL();

	setCarryCookie(cookies, STATE_COOKIE, state, STATE_TTL_SECONDS);
	if (codeVerifier) setCarryCookie(cookies, CODE_VERIFIER_COOKIE, codeVerifier, STATE_TTL_SECONDS);

	// Carry the operator's typed display name / email through the provider's
	// round-trip. Signed so the callback can trust the values without a
	// server-side stash; expires alongside the state cookie.
	const carry = sign({ displayName, email }, CARRY_TTL_MS);
	setCarryCookie(cookies, SETUP_OAUTH_CARRY_COOKIE, carry, STATE_TTL_SECONDS);

	return json({ url: oauthUrl.toString() });
};
