/**
 * DELETE /api/auth/sessions/[id] — revoke one of your own sessions.
 *
 * `[id]` is the sha256 of that session's cookie token, which is what the
 * device list renders. Safe to round-trip through the client: it's the stored
 * form, and it can't be reversed into a usable cookie.
 *
 * Revoking the session you're currently using is allowed — it's just a sign
 * out, and the next request resolves to no user. The client redirects to
 * /login when it recognizes that case.
 */
import { error, json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import { clearSessionCookie, revokeSessionForUser } from '$lib/server/auth/session';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = ({ locals, params, cookies }) => {
	requireUser(locals);
	// Scoped by user id, so another user's session id matches nothing and 404s
	// — the same "don't distinguish gone from not-yours" shape the media and
	// conversation routes use.
	if (!revokeSessionForUser(locals.user.id, params.id)) {
		throw error(404, 'Session not found');
	}
	const self = params.id === locals.sessionId;
	// Revoking your own session leaves a cookie pointing at a deleted row.
	// It would fail to resolve anyway, but clearing it keeps the browser from
	// sending a dead token on every subsequent request.
	if (self) clearSessionCookie(cookies);
	return json({ ok: true, self });
};
