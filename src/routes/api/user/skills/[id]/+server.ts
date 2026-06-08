/**
 * PATCH  /api/user/skills/:id — toggle a skill's `enabled` flag.
 * DELETE /api/user/skills/:id — remove a skill (catalog row + on-disk bundle).
 *
 * Both scope to the caller via the query layer's user_id WHERE clause, so a
 * fabricated or foreign id surfaces as a 404 rather than touching another
 * user's row. Editing a skill is delete + re-import (the SKILL.md frontmatter
 * is the source of truth for name/description), so there is no body-edit PATCH.
 */
import { error, json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import { parseJsonBody } from '$lib/server/http';
import { deleteSkill, setSkillEnabled } from '$lib/server/db/queries/skills';
import { getSkillStore } from '$lib/server/skills/disk-store';
import type { RequestHandler } from './$types';

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	requireUser(locals);
	const body = await parseJsonBody<{ enabled?: unknown }>(request);
	if (typeof body.enabled !== 'boolean') {
		throw error(400, "Expected a boolean 'enabled' field.");
	}
	const matched = setSkillEnabled(locals.user.id, params.id, body.enabled);
	if (!matched) throw error(404, 'Skill not found');
	return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
	requireUser(locals);
	// Delete the DB row first; only then remove the bundle (a file unlink isn't
	// transactional, so orphaning bytes is recoverable but a dangling row isn't).
	const deleted = deleteSkill(locals.user.id, params.id);
	if (!deleted) throw error(404, 'Skill not found');
	await getSkillStore().deleteBundle(deleted.storagePath);
	return new Response(null, { status: 204 });
};
