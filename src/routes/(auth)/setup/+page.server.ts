import { redirect } from '@sveltejs/kit';
import { setupGate } from '$lib/server/auth/setup';
import { githubLoginEnabled, passkeyLoginEnabled } from '$lib/server/env';
import type { PageServerLoad } from './$types';

const ERROR_MESSAGES: Record<string, string> = {
	invalid_oauth_state: 'Setup attempt failed (state mismatch). Please try again.',
	oauth_exchange_failed: 'Could not complete sign-in with GitHub. Please try again.',
	upstream_failure: 'GitHub is unreachable right now. Please try again in a moment.',
	setup_token_required: 'A setup token is required to continue.',
};

// `upstream_failure` reuses the same operator-friendly wording the
// login page uses, so the callback can emit a single code that fits
// both contexts.

/**
 * First-run wizard load. Three branches keyed off the setupGate
 * verdict:
 *  - `closed`  → redirect to /login (a user already exists; nothing
 *               to set up).
 *  - `needs-token` → render the page with a "token required" error
 *                    (no buttons — just an explanation).
 *  - `allowed` → render the wizard.
 *
 * Also surfaces which login methods are enabled so the page can hide
 * a button when its method is globally disabled. We expose the
 * verified token to the client so subsequent fetches can include it
 * in their URLs — the API endpoints re-validate via setupGate, so
 * leaking it back into the DOM is fine (it's already in the URL).
 */
export const load: PageServerLoad = ({ url }) => {
	const verdict = setupGate(url);
	if (verdict === 'closed') throw redirect(302, '/login');
	const token = url.searchParams.get('token') ?? '';
	const errorCode = url.searchParams.get('error');
	const errorMessage = errorCode ? (ERROR_MESSAGES[errorCode] ?? 'Setup failed.') : null;
	return {
		gated: verdict === 'needs-token',
		token,
		errorMessage,
		methods: { github: githubLoginEnabled(), passkey: passkeyLoginEnabled() },
	};
};
