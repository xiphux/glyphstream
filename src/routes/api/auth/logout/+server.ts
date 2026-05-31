import { redirect } from '@sveltejs/kit';
import {
	clearSessionCookie,
	invalidateSession,
	readSessionCookie,
	validateSessionToken,
} from '$lib/server/auth/session';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ cookies }) => {
	const token = readSessionCookie(cookies);
	if (token) {
		const ctx = validateSessionToken(token);
		if (ctx) invalidateSession(ctx.sessionId);
	}
	clearSessionCookie(cookies);
	throw redirect(302, '/login');
};
