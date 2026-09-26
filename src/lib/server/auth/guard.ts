import { error, redirect } from '@sveltejs/kit';
import { APP_LOCKED_STATUS } from '$lib/app-lock';
import { countUsers } from '../db/queries/users';

/**
 * Assert the request is authenticated, throwing a 401 (no session) or a 423
 * (an app-locked session — see server/auth/app-lock.ts) otherwise.
 *
 * Written as a TypeScript assertion function: after `requireUser(locals)`
 * the compiler narrows `locals.user` to non-null for the rest of the
 * handler, so existing `locals.user.id` accesses keep type-checking with
 * no rename.
 *
 * This is the single definition of the /api/* surface's 401 and 423. The bare
 * /api/* routes guard themselves here (rather than in hooks.server.ts)
 * so the hook stays simple and the auth/* + health exemptions need no
 * special-casing.
 */
export function requireUser(
	locals: App.Locals,
): asserts locals is App.Locals & { user: NonNullable<App.Locals['user']> } {
	if (!locals.user) {
		// A locked session (see server/auth/app-lock.ts) is a session, just not
		// a usable one — 423 so the client can send it to /unlock, not /login.
		if (locals.appLock?.locked) error(APP_LOCKED_STATUS, 'App locked');
		error(401, 'Authentication required');
	}
}

/**
 * Where an `(app)` page load sends a request with no usable session: the
 * unlock screen for an app-locked session, the first-run wizard on a fresh
 * install, and the login page otherwise. The one definition shared by the
 * `(app)` layout and `requireUserPage`, so the two can't disagree.
 */
export function redirectUnauthenticatedPage(locals: App.Locals, url: URL): never {
	const from = encodeURIComponent(url.pathname + url.search);
	if (locals.appLock?.locked) redirect(302, `/unlock?from=${from}`);
	// Fresh-install bootstrap: route the operator to the first-run wizard
	// instead of a /login page they can't sign in at yet.
	if (countUsers() === 0) redirect(302, '/setup');
	redirect(302, `/login?from=${encodeURIComponent(url.pathname)}`);
}

/**
 * The `(app)` **page**-load equivalent of `requireUser`: redirect rather than
 * 401, matching what the `(app)` layout does for an unauthenticated request.
 *
 * Exists so a page load can guard itself *without* `await parent()`. The
 * convention is that every `(app)` page load awaits the parent, because a page
 * that dereferences `locals.user!` races the layout's redirect and surfaces a
 * 500 instead of a 302. But `await parent()` also sets SvelteKit's
 * `uses.parent`, which makes the page re-run — and re-serialize everything it
 * returns — whenever the layout re-runs. For a page whose payload is large
 * (the chat route ships the whole active branch, `content_html` included),
 * that turns a targeted `invalidate('app:conversations')` into a full
 * conversation refetch.
 *
 * Guarding here instead keeps the 302 without the coupling: the layout and the
 * page reach the identical redirect from the identical condition, so whichever
 * resolves first, the outcome is the same. Only use this on a page load that
 * genuinely needs no parent data.
 */
export function requireUserPage(
	locals: App.Locals,
	url: URL,
): asserts locals is App.Locals & { user: NonNullable<App.Locals['user']> } {
	if (!locals.user) redirectUnauthenticatedPage(locals, url);
}

/**
 * Assert the request is authenticated AND the user is an admin, throwing
 * 401 (no session), 423 (app-locked session) or 403 (signed in, not an
 * admin) otherwise.
 *
 * Like `requireUser`, it's an assertion function: after `requireAdmin(locals)`
 * the compiler narrows `locals.user` to non-null. Admin gates operator
 * capability (the user-management UI), not data access — admins still only
 * see their own conversations/media; nothing in the data layer keys off role.
 */
export function requireAdmin(
	locals: App.Locals,
): asserts locals is App.Locals & { user: NonNullable<App.Locals['user']> } {
	requireUser(locals);
	if (locals.user.role !== 'admin') error(403, 'Administrator access required');
}

/**
 * Unwrap an ownership-scoped DB lookup result or throw a 404.
 *
 * Most route handlers follow the pattern:
 *
 *   requireUser(locals);
 *   const x = getXForUser(params.id, locals.user.id);
 *   if (!x) error(404, 'X not found');
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
	if (!value) error(404, notFoundMessage);
	return value;
}
