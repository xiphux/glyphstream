/**
 * GET  /api/user/skills — list the caller's skills (settings management UI).
 * POST /api/user/skills — import a skill, either as a pasted SKILL.md
 *   (application/json `{ content }`) or as a multi-file bundle
 *   (multipart/form-data, each `file` part's filename carrying its
 *   bundle-relative path — the browser folder-upload shape).
 *
 * The model's read path is the system-prompt catalog + activate_skill, not
 * these endpoints. Import parses + validates the SKILL.md frontmatter and
 * stores the bundle on disk; a duplicate name is a 409.
 */
import { error, json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import { parseJsonBody } from '$lib/server/http';
import { listSkillsForUser } from '$lib/server/db/queries/skills';
import { importSkillBundle } from '$lib/server/skills/import-skill';
import type { SkillBundleFile } from '$lib/server/skills/store';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals }) => {
	requireUser(locals);
	return json({ skills: listSkillsForUser(locals.user.id) });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	requireUser(locals);
	const contentType = request.headers.get('content-type') ?? '';

	let files: SkillBundleFile[];
	if (contentType.includes('application/json')) {
		const body = await parseJsonBody<{ content?: unknown }>(request);
		if (typeof body.content !== 'string' || body.content.trim().length === 0) {
			throw error(400, "Expected a non-empty 'content' string (the SKILL.md text).");
		}
		files = [{ relPath: 'SKILL.md', bytes: Buffer.from(body.content, 'utf8') }];
	} else if (contentType.includes('multipart/form-data')) {
		const form = await request.formData();
		const uploaded = form.getAll('file').filter((v): v is File => v instanceof File);
		if (uploaded.length === 0) throw error(400, 'No files in the upload.');
		files = [];
		for (const f of uploaded) {
			files.push({ relPath: f.name, bytes: Buffer.from(await f.arrayBuffer()) });
		}
	} else {
		throw error(415, 'Send application/json {content} or multipart/form-data files.');
	}

	const result = await importSkillBundle(locals.user.id, files);
	if (!result.ok) throw error(result.status, result.error);
	return json({ skill: result.skill }, { status: 201 });
};
