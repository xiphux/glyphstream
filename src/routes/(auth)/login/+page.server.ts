import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

const ERROR_MESSAGES: Record<string, string> = {
	invalid_oauth_state: 'Login attempt failed (state mismatch). Please try again.',
	oauth_exchange_failed: 'Could not complete sign-in with GitHub. Please try again.',
	upstream_failure: 'GitHub is unreachable right now. Please try again in a moment.',
	not_authorized: 'This GitHub account is not authorized to use this instance.'
};

export const load: PageServerLoad = ({ locals, url }) => {
	if (locals.user) throw redirect(302, '/');
	const errorCode = url.searchParams.get('error');
	const errorMessage = errorCode ? (ERROR_MESSAGES[errorCode] ?? 'Login failed.') : null;
	return { errorMessage };
};
