/**
 * GET  /api/user/prompt-snippets — the caller's snippet library.
 * POST /api/user/prompt-snippets — create one snippet.
 *
 * GET serves two consumers: the settings management UI, and the composer's
 * lazy autocomplete fetch (the library is deliberately NOT in the (app) layout
 * payload — ~100 style paragraphs would ride every page load for a feature
 * many sessions never touch).
 */
import { error, json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import { parseJsonBody } from '$lib/server/http';
import {
	createPromptSnippet,
	listPromptSnippetsForUser,
	promptSnippetExistsByName,
} from '$lib/server/db/queries/prompt-snippets';
import { validateCreateSnippet } from '$lib/server/prompt-snippets/validate';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals }) => {
	requireUser(locals);
	return json({ promptSnippets: listPromptSnippetsForUser(locals.user.id) });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	requireUser(locals);
	const body = await parseJsonBody<Record<string, unknown>>(request);
	const input = validateCreateSnippet(body);

	// Pre-flight so a duplicate reads as a 409 with a useful message rather
	// than surfacing the raw unique-index violation as a 500.
	if (promptSnippetExistsByName(locals.user.id, input.name)) {
		throw error(409, `A snippet named "${input.name}" already exists.`);
	}

	const promptSnippet = createPromptSnippet({ userId: locals.user.id, ...input });
	return json({ promptSnippet }, { status: 201 });
};
