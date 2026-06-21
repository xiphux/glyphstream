import { redirect } from '@sveltejs/kit';
import { findValidInvite } from '$lib/server/db/queries/invites';
import { passkeyLoginEnabled } from '$lib/server/env';
import { listEnabledProviders } from '$lib/server/auth/oauth/registry';
import type { PageServerLoad } from './$types';

const ERROR_MESSAGES: Record<string, string> = {
	invalid_oauth_state: 'Sign-up attempt failed (state mismatch). Please try again.',
	oauth_exchange_failed: 'Could not complete sign-in. Please try again.',
	upstream_failure: 'The sign-in provider is unreachable right now. Please try again in a moment.',
	invite_invalid: 'This invite link is no longer valid. Ask your administrator for a new one.',
	already_registered: 'That account is already registered. Try signing in instead.',
	signup_failed: 'Something went wrong creating your account. Please try again.',
};

/**
 * Invite-redemption page. Mirrors the `/setup` wizard, but gated by a valid
 * invite token (path param) rather than the zero-users setup gate.
 *
 *  - Already signed in → redirect home (no point redeeming an invite in a
 *    browser that already has an account).
 *  - Invalid / expired / used token → render an "invalid invite" state with
 *    no sign-up buttons.
 *  - Valid token → render the wizard, carrying the token to the API
 *    endpoints, which re-validate it on every call.
 */
export const load: PageServerLoad = ({ params, url, locals }) => {
	if (locals.user) throw redirect(302, '/');

	const invite = findValidInvite(params.token);
	const errorCode = url.searchParams.get('error');
	const errorMessage = errorCode ? (ERROR_MESSAGES[errorCode] ?? 'Sign-up failed.') : null;

	return {
		valid: invite !== null,
		token: params.token,
		errorMessage,
		methods: {
			providers: listEnabledProviders().map((p) => ({ id: p.id, label: p.label() })),
			passkey: passkeyLoginEnabled(),
		},
	};
};
