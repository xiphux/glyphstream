/**
 * PUT    /api/user/schedules/:id — replace a schedule's settings.
 * PATCH  /api/user/schedules/:id — `{ enabled }` only: the list's on/off
 *        toggle, which must not re-copy a custom model's preset as a full
 *        save does.
 * DELETE /api/user/schedules/:id — delete it. Its past runs' conversations
 *        stay; they just stop being marked as scheduled.
 *
 * Scoped by the caller in the query layer, so another user's id is a 404.
 */
import { error } from '@sveltejs/kit';
import { requireUser } from '#lib/server/auth/guard.js';
import { parseJsonBody } from '#lib/server/http.js';
import {
	deleteScheduledTask,
	getScheduledTask,
	setScheduledTaskEnabled,
	updateScheduledTask,
} from '#lib/server/db/queries/scheduled-tasks.js';
import { firstSlot, requireScheduledTasksEnabled } from '#lib/server/scheduled/http.js';
import { validateScheduledTaskBody } from '#lib/server/scheduled/validate.js';
import type { RequestHandler } from './$types';

export const PUT: RequestHandler = async ({ locals, params, request }) => {
	requireUser(locals);
	requireScheduledTasksEnabled();
	const input = await validateScheduledTaskBody(
		await parseJsonBody<Record<string, unknown>>(request),
		locals.user.id,
	);
	const schedule = updateScheduledTask(params.id, locals.user.id, input, firstSlot(input));
	if (!schedule) error(404, 'Scheduled task not found');
	return Response.json({ schedule });
};

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	requireUser(locals);
	requireScheduledTasksEnabled();
	const body = await parseJsonBody<Record<string, unknown>>(request);
	if (typeof body.enabled !== 'boolean') error(400, "'enabled' must be a boolean");
	const existing = getScheduledTask(params.id, locals.user.id);
	if (!existing) error(404, 'Scheduled task not found');
	const schedule = setScheduledTaskEnabled(
		params.id,
		locals.user.id,
		body.enabled,
		firstSlot({ ...existing, enabled: body.enabled }),
	);
	if (!schedule) error(404, 'Scheduled task not found');
	return Response.json({ schedule });
};

export const DELETE: RequestHandler = ({ locals, params }) => {
	requireUser(locals);
	requireScheduledTasksEnabled();
	if (!deleteScheduledTask(params.id, locals.user.id)) error(404, 'Scheduled task not found');
	return new Response(null, { status: 204 });
};
