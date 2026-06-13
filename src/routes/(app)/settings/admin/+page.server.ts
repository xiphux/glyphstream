import { requireAdmin } from '$lib/server/auth/guard';
import { listUsers } from '$lib/server/db/queries/users';
import { listInvites } from '$lib/server/db/queries/invites';
import type { PageServerLoad } from './$types';

/**
 * Admin user-management page. Admin-only (requireAdmin throws 403 for
 * non-admins). `depends('settings:admin')` lets the page re-fetch after an
 * invite/disable/delete mutation without re-running the (app) layout load.
 */
export const load: PageServerLoad = async ({ locals, parent, depends }) => {
	// await parent() before deref'ing locals.user — see the (app) layout note
	// in CLAUDE.md (avoids a 500/302 race on the no-auth path).
	await parent();
	requireAdmin(locals);
	depends('settings:admin');
	return {
		me: locals.user.id,
		users: listUsers(),
		// Only outstanding invites — a used invite is inert (single-use is
		// enforced) and its redeemer already shows up in the Users list, so
		// listing it just clutters. The row is kept in the DB as a latent
		// audit record (who joined via which invite); `listInvites()` still
		// returns all of them for any future audit view.
		invites: listInvites().filter((i) => i.usedAt === null),
	};
};
