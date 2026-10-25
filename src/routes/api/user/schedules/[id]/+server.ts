/**
 * PUT    /api/user/schedules/:id — replace a schedule's settings.
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

export const DELETE: RequestHandler = ({ locals, params }) => {
	requireUser(locals);
	requireScheduledTasksEnabled();
	if (!deleteScheduledTask(params.id, locals.user.id)) error(404, 'Scheduled task not found');
	return new Response(null, { status: 204 });
};
