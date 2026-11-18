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

/**
 * A schedule made from a custom model keeps its own copy of the preset's
 * system prompt and parameters, and deleting the preset nulls only
 * `customModelId`. The editor can't show or send that copy, so a save that
 * names no preset, no system prompt, and the same model keeps it.
 */
export const PUT: RequestHandler = async ({ locals, params, request }) => {
	requireUser(locals);
	requireScheduledTasksEnabled();
	const body = await parseJsonBody<Record<string, unknown>>(request);
	const input = await validateScheduledTaskBody(body, locals.user.id);
	const existing = getScheduledTask(params.id, locals.user.id);
	if (!existing) error(404, 'Scheduled task not found');
	if (
		input.customModelId === null &&
		body.systemPrompt === undefined &&
		existing.customModelId === null &&
		existing.modelId === input.modelId
	) {
		input.systemPrompt = existing.systemPrompt;
		input.parameters = existing.parameters;
	}
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
