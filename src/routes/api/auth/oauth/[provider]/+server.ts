/**
 * DELETE /api/auth/oauth/:provider — unbind a provider from the
 * current user. User-scoped via `requireUser`; refuses with 409 when
 * the unlink would leave the user with no viable sign-in method
 * (no remaining OAuth bindings AND no registered passkeys).
 */
import { error } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import {
	countOAuthAccountsForUser,
	deleteOAuthAccount,
} from '$lib/server/db/queries/oauth-accounts';
import { countCredentialsForUser } from '$lib/server/db/queries/passkey';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = ({ locals, params }) => {
	requireUser(locals);
	const remainingOAuth = countOAuthAccountsForUser(locals.user.id) - 1;
	const passkeyCount = countCredentialsForUser(locals.user.id);
	if (remainingOAuth + passkeyCount <= 0) {
		throw error(
			409,
			"Can't unlink your last sign-in method. Add a passkey or another provider first.",
		);
	}
	const matched = deleteOAuthAccount(locals.user.id, params.provider);
	if (!matched) throw error(404, 'OAuth binding not found');
	return new Response(null, { status: 204 });
};
