/**
 * POST /api/user/prompt-snippets/:id/use — record that a snippet was inserted.
 *
 * Drives most-used-first ordering in the autocomplete. Fire-and-forget from the
 * composer: the caller ignores the response, and an unknown/foreign id returns
 * 204 rather than 404 on purpose — a lost usage count is not worth an error
 * path in the insertion hot path, and the counter is not security-relevant.
 * The bump itself is still user-scoped, so it can't touch another user's row.
 */
import { requireUser } from '$lib/server/auth/guard';
import { bumpSnippetUsage } from '$lib/server/db/queries/prompt-snippets';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ locals, params }) => {
	requireUser(locals);
	bumpSnippetUsage(params.id, locals.user.id);
	return new Response(null, { status: 204 });
};
