import { error } from '@sveltejs/kit';
import { listCredentialSummariesForUser } from '$lib/server/db/queries/passkey';
import { githubLoginEnabled, passkeyLoginEnabled } from '$lib/server/env';
import type { PageServerLoad } from './$types';

/**
 * SSR the user's passkey list. `await parent()` first per the (app) page
 * convention — without it the `locals.user!.id` deref races the layout's
 * redirect-on-no-auth and surfaces as a 500 instead of a 302.
 *
 * The list is loaded even when PASSKEY_LOGIN_ENABLED is false so the
 * operator can still prune stale rows; the "Add passkey" button is the
 * only thing that hides behind the toggle.
 */
export const load: PageServerLoad = async ({ locals, parent, depends }) => {
	await parent();
	if (!locals.user) throw error(401, 'Authentication required');
	depends('settings:passkeys');
	const passkeys = listCredentialSummariesForUser(locals.user.id);
	return {
		passkeys,
		githubEnabled: githubLoginEnabled(),
		passkeyEnabled: passkeyLoginEnabled(),
		githubUsername: locals.user.githubUsername,
	};
};
