/** GET /api/user/schedules/:id/runs — the schedule's run history, newest first. */
import { error } from '@sveltejs/kit';
import { requireUser } from '#lib/server/auth/guard.js';
import { getScheduledTask, listScheduledRuns } from '#lib/server/db/queries/scheduled-tasks.js';
import { requireScheduledTasksEnabled } from '#lib/server/scheduled/http.js';
import type { ScheduledRunsResponse } from '#lib/types/api.js';
import type { RequestHandler } from './$types';

const HISTORY_LIMIT = 50;

export const GET: RequestHandler = ({ locals, params }) => {
	requireUser(locals);
	requireScheduledTasksEnabled();
	if (!getScheduledTask(params.id, locals.user.id)) error(404, 'Scheduled task not found');
	return Response.json({
		runs: listScheduledRuns(params.id, locals.user.id, HISTORY_LIMIT),
	} satisfies ScheduledRunsResponse);
};
