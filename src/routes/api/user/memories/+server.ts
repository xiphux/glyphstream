/**
 * GET /api/user/memories — list the caller's saved memories.
 *
 * The settings page hits this to render the management UI. The model's
 * read path is the system-prompt injection (composePersonaSystemPrompt),
 * not this endpoint. The model's write path is the save/update/forget
 * tools, not a POST/PATCH — locked-in scope for the MVP is view + delete
 * only, no manual add/edit from the UI.
 */
import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import { listMemoriesForUser } from '$lib/server/db/queries/memories';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals }) => {
	requireUser(locals);
	const memories = listMemoriesForUser(locals.user.id);
	return json({ memories });
};
