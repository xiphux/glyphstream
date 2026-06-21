import { redirect } from '@sveltejs/kit';
import { countUsers } from '$lib/server/db/queries/users';
import { passkeyLoginEnabled } from '$lib/server/env';
import { listEnabledProviders } from '$lib/server/auth/oauth/registry';
import type { PageServerLoad } from './$types';

const ERROR_MESSAGES: Record<string, string> = {
	invalid_oauth_state: 'Login attempt failed (state mismatch). Please try again.',
	oauth_exchange_failed: 'Could not complete sign-in. Please try again.',
	upstream_failure: 'The sign-in provider is unreachable right now. Please try again in a moment.',
	not_authorized: 'This account is not authorized to use this instance.',
	provider_not_bound:
		"This account isn't linked to any user. Sign in with a method you've already bound, then link this provider from Settings → Security.",
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
	// least one usable method here — a provider with credentials, or
	// passkeys — so the page can never render with zero controls.
	return {
		errorMessage,
		methods: {
			providers: listEnabledProviders().map((p) => ({ id: p.id, label: p.label() })),
			passkey: passkeyLoginEnabled(),
		},
	};
};
