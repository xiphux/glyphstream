import { error } from '@sveltejs/kit';

/**
 * Assert the request is authenticated, throwing a 401 otherwise.
 *
 * Written as a TypeScript assertion function: after `requireUser(locals)`
 * the compiler narrows `locals.user` to non-null for the rest of the
 * handler, so existing `locals.user.id` accesses keep type-checking with
 * no rename.
 *
 * This is the single definition of the /api/* surface's 401. The bare
 * /api/* routes guard themselves here (rather than in hooks.server.ts)
 * so the hook stays simple and the auth/* + health exemptions need no
 * special-casing.
 */
export function requireUser(
	locals: App.Locals
): asserts locals is App.Locals & { user: NonNullable<App.Locals['user']> } {
	if (!locals.user) throw error(401, 'Authentication required');
}
