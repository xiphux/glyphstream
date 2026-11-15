/**
 * GET /api/user/memories — list the caller's saved memories.
 *
 * The settings page hits this to render the management UI. The model's
 * read path is the system-prompt injection (composePersonaSystemPrompt),
 * not this endpoint. The model's write path is the save/update/forget
 * tools, not a POST/PATCH — the UI is view + delete only, with no manual
 * add/edit.
 */

import { requireUser } from '#lib/server/auth/guard.js';
import { listMemoriesForUser } from '#lib/server/db/queries/memories.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals }) => {
	requireUser(locals);
	const memories = listMemoriesForUser(locals.user.id);
	return Response.json({ memories });
};
