import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/**
 * Redirects the former user-management path to `/settings/users`. Kept because
 * this is self-hosted software an operator may well have bookmarked, and a 404
 * there reads as "the admin panel is gone".
 *
 * No auth check: the redirect target does the real one, and gating the
 * redirect would only mean an unauthenticated hit gets a 401 here instead of
 * the login bounce it should get there.
 */
export const load: PageServerLoad = () => {
	redirect(308, '/settings/users');
};
