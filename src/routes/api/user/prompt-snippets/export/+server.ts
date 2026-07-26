/**
 * GET /api/user/prompt-snippets/export — download the library as one Markdown
 * file, in the same format the importer accepts.
 *
 * Round-tripping is the point: the export is a backup, a way to hand-edit ~100
 * snippets in a real editor, and a way to move a library between instances.
 */
import { requireUser } from '$lib/server/auth/guard';
import { listPromptSnippetsForUser } from '$lib/server/db/queries/prompt-snippets';
import { serializeSnippetMarkdown } from '$lib/server/prompt-snippets/markdown';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals }) => {
	requireUser(locals);
	const body = serializeSnippetMarkdown(listPromptSnippetsForUser(locals.user.id));
	return new Response(body, {
		headers: {
			'content-type': 'text/markdown; charset=utf-8',
			'content-disposition': 'attachment; filename="prompt-snippets.md"',
		},
	});
};
