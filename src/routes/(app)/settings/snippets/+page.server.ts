import { error } from '@sveltejs/kit';
import { listPromptSnippetsForUser } from '$lib/server/db/queries/prompt-snippets';
import type { PageServerLoad } from './$types';

// `await parent()` first: without it this load's `locals.user` deref races the
// (app) layout's redirect-on-no-auth and surfaces a 500 instead of a 302.
//
// No `depends()` here. The composer's autocomplete reads the client-side cache
// in `$lib/prompt-snippets.svelte.ts`, not layout data, so mutations on this
// page call `invalidateSnippets()` rather than `invalidate('app:…')`.
export const load: PageServerLoad = async ({ locals, parent }) => {
	await parent();
	if (!locals.user) error(401, 'Authentication required');
	return { promptSnippets: listPromptSnippetsForUser(locals.user.id) };
};
