import { redirect } from '@sveltejs/kit';
import { countUsers } from '$lib/server/db/queries/users';
import { githubLoginEnabled, passkeyLoginEnabled } from '$lib/server/env';
import type { PageServerLoad } from './$types';

const ERROR_MESSAGES: Record<string, string> = {
	invalid_oauth_state: 'Login attempt failed (state mismatch). Please try again.',
	oauth_exchange_failed: 'Could not complete sign-in with GitHub. Please try again.',
	upstream_failure: 'GitHub is unreachable right now. Please try again in a moment.',
	not_authorized: 'This account is not authorized to use this instance.',
	provider_not_bound:
		"This GitHub account isn't linked to the operator account. Sign in with a method you've already bound, then link GitHub from Settings → Security.",
	setup_required: 'No operator account exists yet. Complete the first-run setup at /setup.',
};

export const load: PageServerLoad = ({ locals, url }) => {
	if (locals.user) throw redirect(302, '/');
	// On a fresh install the only way forward is the wizard. Redirect
	// here too so a bookmarked /login on a clean DB lands operators in
	// the right place.
	if (countUsers() === 0) throw redirect(302, '/setup');
	const errorCode = url.searchParams.get('error');
	const errorMessage = errorCode ? (ERROR_MESSAGES[errorCode] ?? 'Login failed.') : null;
	// Expose which login methods are enabled so the page can render the
	// right buttons. validateAuthMethodsEnabled() at boot guarantees at
	// least one is true.
	return {
		errorMessage,
		methods: { github: githubLoginEnabled(), passkey: passkeyLoginEnabled() },
	};
};
