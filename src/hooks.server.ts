import type { Handle } from '@sveltejs/kit';
import { readSessionCookie, validateSessionToken } from '$lib/server/auth/session';

/**
 * Populate event.locals.user on every request from the session cookie.
 * Routes/layouts decide whether to require it; this hook just *reads*.
 *
 * The bare /api/* surface (other than /api/auth/* and /api/health) checks
 * locals.user itself — done in each +server.ts to keep the hook simple.
 */
export const handle: Handle = async ({ event, resolve }) => {
	const token = readSessionCookie(event.cookies);
	const ctx = token ? validateSessionToken(token) : null;
	event.locals.user = ctx?.user ?? null;
	return resolve(event);
};
