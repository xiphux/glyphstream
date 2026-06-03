/**
 * DELETE /api/auth/oauth/:provider — unbind a provider from the
 * current user. User-scoped via `requireUser`; refuses with 409 when
 * the unlink would leave the user with no viable sign-in method
 * (no remaining OAuth bindings AND no registered passkeys).
 *
 * Check the binding exists BEFORE applying the last-method math.
 * A user with no bindings calling DELETE for an arbitrary provider
 * would otherwise hit a `count - 1` underflow and produce a
 * misleading 409 instead of 404.
 */
import { error } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import {
	deleteOAuthAccount,
	listOAuthAccountsForUser,
} from '$lib/server/db/queries/oauth-accounts';
import { countCredentialsForUser } from '$lib/server/db/queries/passkey';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = ({ locals, params }) => {
	requireUser(locals);
	const accounts = listOAuthAccountsForUser(locals.user.id);
	const bound = accounts.some((a) => a.provider === params.provider);
	if (!bound) throw error(404, 'OAuth binding not found');

	const passkeyCount = countCredentialsForUser(locals.user.id);
	// `accounts.length - 1` is the count after the impending delete.
	if (accounts.length - 1 + passkeyCount <= 0) {
		throw error(
			409,
			"Can't unlink your last sign-in method. Add a passkey or another provider first.",
		);
	}

	deleteOAuthAccount(locals.user.id, params.provider);
	return new Response(null, { status: 204 });
};
