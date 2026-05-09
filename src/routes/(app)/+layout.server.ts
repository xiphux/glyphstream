import { redirect } from '@sveltejs/kit';
import { listConversations } from '$lib/server/db/queries/conversations';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals, url }) => {
	if (!locals.user) {
		throw redirect(302, `/login?from=${encodeURIComponent(url.pathname)}`);
	}
	return {
		user: locals.user,
		conversations: listConversations(locals.user.id)
	};
};
