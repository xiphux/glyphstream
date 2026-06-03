import { error } from '@sveltejs/kit';
import { listOAuthAccountsForUser } from '$lib/server/db/queries/oauth-accounts';
import { listCredentialSummariesForUser } from '$lib/server/db/queries/passkey';
import { githubLoginEnabled, passkeyLoginEnabled } from '$lib/server/env';
import type { PageServerLoad } from './$types';

/**
 * SSR the operator's auth state — bound OAuth providers + registered
 * passkeys. `await parent()` first per the (app) page convention —
 * without it the `locals.user!.id` deref races the layout's
 * redirect-on-no-auth and surfaces as a 500 instead of a 302.
 *
 * Lists load even when the corresponding *_LOGIN_ENABLED toggle is off
 * so the operator can still see / prune existing rows; the add-flow
 * buttons are what hide.
 */
export const load: PageServerLoad = async ({ locals, parent, depends }) => {
	await parent();
	if (!locals.user) throw error(401, 'Authentication required');
	depends('settings:passkeys');
	depends('settings:oauth-accounts');
	const passkeys = listCredentialSummariesForUser(locals.user.id);
	const oauthAccounts = listOAuthAccountsForUser(locals.user.id);
	return {
		passkeys,
		oauthAccounts,
		githubEnabled: githubLoginEnabled(),
		passkeyEnabled: passkeyLoginEnabled(),
	};
};
