/**
 * GET  /api/user/schedules — the caller's scheduled tasks, each with its latest run.
 * POST /api/user/schedules — create one.
 */
import { error } from '@sveltejs/kit';
import { requireUser } from '#lib/server/auth/guard.js';
import { parseJsonBody } from '#lib/server/http.js';
import {
	countScheduledTasks,
	createScheduledTask,
	latestScheduledRuns,
	listScheduledTasks,
} from '#lib/server/db/queries/scheduled-tasks.js';
import { getScheduledTasksConfig } from '#lib/server/endpoints/config.js';
import { firstSlot, requireScheduledTasksEnabled } from '#lib/server/scheduled/http.js';
import { validateScheduledTaskBody } from '#lib/server/scheduled/validate.js';
import type { ScheduledTasksResponse } from '#lib/types/api.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals }) => {
	requireUser(locals);
	requireScheduledTasksEnabled();
	const tasks = listScheduledTasks(locals.user.id);
	const latest = latestScheduledRuns(
		tasks.map((t) => t.id),
		locals.user.id,
	);
	return Response.json({
		schedules: tasks.map((t) => ({ ...t, lastRun: latest.get(t.id) ?? null })),
	} satisfies ScheduledTasksResponse);
};

export const POST: RequestHandler = async ({ locals, request }) => {
	requireUser(locals);
	requireScheduledTasksEnabled();
	// Opt-in cap (`[scheduled_tasks] max_per_user`); admins are exempt, as from
	// every per-user limit.
	const max = getScheduledTasksConfig().maxPerUser;
	if (locals.user.role !== 'admin' && max !== null && countScheduledTasks(locals.user.id) >= max) {
		error(403, `You can keep at most ${max} scheduled tasks on this server.`);
	}
	const input = await validateScheduledTaskBody(
		await parseJsonBody<Record<string, unknown>>(request),
		locals.user.id,
	);
	const schedule = createScheduledTask(locals.user.id, input, firstSlot(input));
	return Response.json({ schedule }, { status: 201 });
};
