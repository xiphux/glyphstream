/** Shared request-side helpers for the scheduled-task API routes. */
import { error } from '@sveltejs/kit';
import type { ScheduledTask } from '#lib/types/api.js';
import { getScheduledTasksConfig } from '../endpoints/config';
import { nextSlotAfter } from './cadence';

/** 404 when the operator turned the feature off, so the routes read as absent
 *  rather than as an error. */
export function requireScheduledTasksEnabled(): void {
	if (!getScheduledTasksConfig().enabled)
		error(404, 'Scheduled tasks are turned off on this server');
}

/** The first slot after now for a schedule being saved, null if disabled. */
export function firstSlot(
	input: Pick<ScheduledTask, 'cadence' | 'timezone' | 'enabled'>,
	now = Date.now(),
): number | null {
	return input.enabled ? nextSlotAfter(input.cadence, input.timezone, now) : null;
}
