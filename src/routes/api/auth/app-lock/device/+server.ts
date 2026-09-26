/**
 * POST /api/auth/app-lock/device — "this browser is the installed app".
 *
 * The client calls it once per launch when it's running in standalone
 * display mode (the server can't see display-mode). Sets the httpOnly marker
 * that scopes app lock's idle clock to the installed app — see
 * server/auth/app-lock.ts. Unauthenticated on purpose: it's called from the
 * login page too, and the marker can only ever ADD a restriction.
 */
import { setInstalledAppCookie } from '$lib/server/auth/app-lock';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ cookies }) => {
	setInstalledAppCookie(cookies);
	return new Response(null, { status: 204 });
};
