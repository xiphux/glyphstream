/**
 * POST /api/user/prompt-snippets/import — bulk-import a snippet library file.
 *
 * Accepts the pasted text (application/json `{ content, overwrite? }`) or an
 * uploaded `.md` (multipart/form-data, one `file` part) — the same
 * two-content-type shape as skill import. The parse + write logic lives in
 * `import-snippets.ts`; this handler only marshals and maps the result.
 */
import { error, json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import { parseJsonBody } from '$lib/server/http';
import { importSnippets } from '$lib/server/prompt-snippets/import-snippets';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, request }) => {
	requireUser(locals);
	const contentType = request.headers.get('content-type') ?? '';

	let content: string;
	let overwrite: boolean;

	if (contentType.includes('application/json')) {
		const body = await parseJsonBody<{ content?: unknown; overwrite?: unknown }>(request);
		if (typeof body.content !== 'string') {
			error(400, "Expected a 'content' string (the snippet library text).");
		}
		content = body.content;
		overwrite = body.overwrite === true;
	} else if (contentType.includes('multipart/form-data')) {
		let form: FormData;
		try {
			form = await request.formData();
		} catch (e) {
			// adapter-node aborts the body stream past BODY_SIZE_LIMIT, then
			// formData() fails on the truncated body — surface a 413, not a 500.
			const msg = e instanceof Error ? e.message : String(e);
			if (/body.*too.*large|413|exceeded/i.test(msg)) {
				error(
					413,
					'Upload exceeded the request body size limit. Raise BODY_SIZE_LIMIT in the environment.',
				);
			}
			error(400, 'Body must be multipart/form-data.');
		}
		const file = form.get('file');
		if (!(file instanceof File)) error(400, 'No file in the upload.');
		content = await file.text();
		overwrite = form.get('overwrite') === 'true';
	} else {
		error(415, 'Send application/json {content} or multipart/form-data file.');
	}

	const result = importSnippets({ userId: locals.user.id, content, overwrite });
	if (!result.ok) error(result.status, result.error);
	return json({
		imported: result.imported,
		updated: result.updated,
		skipped: result.skipped,
		warnings: result.warnings,
	});
};
