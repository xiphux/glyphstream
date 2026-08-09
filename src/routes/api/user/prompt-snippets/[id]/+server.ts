/**
 * PATCH  /api/user/prompt-snippets/:id — edit a snippet.
 * DELETE /api/user/prompt-snippets/:id — remove one.
 *
 * Both scope to the caller via the query layer's user_id WHERE clause, so a
 * fabricated or foreign id surfaces as a 404 rather than touching another
 * user's row. Editing a snippet does NOT retroactively change messages it was
 * inserted into — an inserted snippet is plain text with no back-link, the
 * same "materialized at use time" contract custom models have.
 */
import { error, json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import { parseJsonBody } from '$lib/server/http';
import {
	deletePromptSnippet,
	getPromptSnippetForUser,
	promptSnippetExistsByName,
	updatePromptSnippet,
} from '$lib/server/db/queries/prompt-snippets';
import { validateUpdateSnippet } from '$lib/server/prompt-snippets/validate';
import type { RequestHandler } from './$types';

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	requireUser(locals);
	const body = await parseJsonBody<Record<string, unknown>>(request);
	const patch = validateUpdateSnippet(body);

	if (patch.name !== undefined) {
		const existing = getPromptSnippetForUser(params.id, locals.user.id);
		if (!existing) error(404, 'Snippet not found');
		// Renaming onto another snippet's name would hit the unique index;
		// renaming to its own current name is a no-op, not a conflict.
		if (patch.name !== existing.name && promptSnippetExistsByName(locals.user.id, patch.name)) {
			error(409, `A snippet named "${patch.name}" already exists.`);
		}
	}

	const promptSnippet = updatePromptSnippet(params.id, locals.user.id, patch);
	if (!promptSnippet) error(404, 'Snippet not found');
	return json({ promptSnippet });
};

export const DELETE: RequestHandler = ({ locals, params }) => {
	requireUser(locals);
	if (!deletePromptSnippet(params.id, locals.user.id)) error(404, 'Snippet not found');
	return new Response(null, { status: 204 });
};
