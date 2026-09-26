import { redirect } from '@sveltejs/kit';
import { safeUnlockReturn } from '$lib/app-lock';
import type { PageServerLoad } from './$types';

/**
 * The app-lock screen (see server/auth/app-lock.ts). Only reachable while the
 * session is locked: an unlocked one goes straight back to where it was headed,
 * and no session at all goes to /login.
 */
export const load: PageServerLoad = ({ locals, url }) => {
	const from = safeUnlockReturn(url.searchParams.get('from'));
	if (!locals.appLock?.locked) redirect(302, locals.user ? from : '/login');
	return { from };
};
