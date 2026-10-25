/**
 * POST /api/user/schedules/:id/run — Run now. Starts a run immediately,
 * whatever the cadence (and even if the schedule is turned off — this is how
 * you try one out). It still queues like any run, behind people waiting on a
 * reply. Returns the run id; the run itself finishes in the background.
 *
 * One at a time per schedule: background runs don't count toward the
 * per-person queue cap, so this is the only thing stopping a held-down button
 * from queuing runs without end. A run waiting on approval holds nothing, so it
 * doesn't block another. The check and the insert are one synchronous step.
 */
import { error } from '@sveltejs/kit';
import { requireUser } from '#lib/server/auth/guard.js';
import { getScheduledTask, hasActiveScheduledRun } from '#lib/server/db/queries/scheduled-tasks.js';
import { requireScheduledTasksEnabled } from '#lib/server/scheduled/http.js';
import { startScheduledRun } from '#lib/server/scheduled/runner.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ locals, params }) => {
	requireUser(locals);
	requireScheduledTasksEnabled();
	const task = getScheduledTask(params.id, locals.user.id);
	if (!task) error(404, 'Scheduled task not found');
	if (hasActiveScheduledRun(task.id, locals.user.id)) {
		error(409, 'This schedule already has a run in progress');
	}
	const runId = startScheduledRun({ ...task, userId: locals.user.id }, Date.now(), 'manual');
	if (!runId) error(409, 'That run is already starting');
	return Response.json({ runId }, { status: 202 });
};
