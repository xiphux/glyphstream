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
	locals: App.Locals,
): asserts locals is App.Locals & { user: NonNullable<App.Locals['user']> } {
	if (!locals.user) throw error(401, 'Authentication required');
}

/**
 * Unwrap an ownership-scoped DB lookup result or throw a 404.
 *
 * Most route handlers follow the pattern:
 *
 *   requireUser(locals);
 *   const x = getXForUser(params.id, locals.user.id);
 *   if (!x) throw error(404, 'X not found');
 *
 * `requireFound` collapses the last two lines, and chains cleanly when a
 * handler needs more than one ownership-scoped lookup (e.g. message
 * routes that resolve both the conversation and the message).
 *
 * A one-shot combined helper that also did `requireUser` was considered,
 * but TS assertion functions can't return values — handlers that read
 * `locals.user.id` later would lose the narrowing. Keeping the two
 * primitives composable preserves narrowing and matches the multi-lookup
 * case.
 */
export function requireFound<T>(value: T | null | undefined, notFoundMessage: string): T {
	if (!value) throw error(404, notFoundMessage);
	return value;
}
