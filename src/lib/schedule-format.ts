/**
 * Human wording for scheduled tasks — a cadence, a run's outcome — shared by
 * the settings page and anything else that names a schedule. Client-safe and
 * pure, so it's tested directly.
 */
import type { ScheduleCadence, ScheduledRun } from '#lib/types/api.js';

const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_LONG = [
	'Sundays',
	'Mondays',
	'Tuesdays',
	'Wednesdays',
	'Thursdays',
	'Fridays',
	'Saturdays',
];

export const WEEKDAYS = [1, 2, 3, 4, 5];
export const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
export const DAY_LABELS = DAY_SHORT;

/** "Weekdays at 07:00", "Every 4 hours", … */
export function describeCadence(cadence: ScheduleCadence): string {
	if (cadence.kind === 'interval') {
		return cadence.everyHours === 1 ? 'Every hour' : `Every ${cadence.everyHours} hours`;
	}
	const days = [...cadence.days].sort((a, b) => a - b);
	const key = days.join(',');
	let when: string;
	if (key === EVERY_DAY.join(',')) when = 'Every day';
	else if (key === WEEKDAYS.join(',')) when = 'Weekdays';
	else if (key === '0,6') when = 'Weekends';
	else if (days.length === 1) when = DAY_LONG[days[0]];
	else when = days.map((d) => DAY_SHORT[d]).join(', ');
	return `${when} at ${cadence.time}`;
}

/** A run's outcome in a few words, and whether it's a problem worth color. */
export function describeRun(run: ScheduledRun): {
	label: string;
	tone: 'ok' | 'warn' | 'bad' | 'muted';
} {
	switch (run.state) {
		case 'queued':
			return { label: 'Waiting for a turn', tone: 'muted' };
		case 'running':
			return { label: 'Running', tone: 'muted' };
		case 'done':
			return { label: 'Finished', tone: 'ok' };
		case 'needs_input':
			return { label: 'Waiting for your approval', tone: 'warn' };
		case 'skipped':
			return {
				label: run.failureKind === 'stopped' ? 'Stopped' : (run.failureDetail ?? 'Skipped'),
				tone: 'muted',
			};
		case 'failed':
			return { label: run.failureDetail ?? 'Failed', tone: 'bad' };
	}
}
