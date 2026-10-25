import { describe, expect, it } from 'vitest';
import { describeCadence, describeRun } from '#lib/schedule-format.js';
import type { ScheduledRun } from '#lib/types/api.js';

describe('describeCadence', () => {
	it.each([
		[[0, 1, 2, 3, 4, 5, 6], 'Every day at 07:00'],
		[[5, 1, 2, 3, 4], 'Weekdays at 07:00'],
		[[6, 0], 'Weekends at 07:00'],
		[[1], 'Mondays at 07:00'],
		[[1, 3, 5], 'Mon, Wed, Fri at 07:00'],
	])('%j', (days, text) => {
		expect(describeCadence({ kind: 'daily', time: '07:00', days })).toBe(text);
	});

	it('words an interval', () => {
		expect(describeCadence({ kind: 'interval', everyHours: 1, anchorAt: 0 })).toBe('Every hour');
		expect(describeCadence({ kind: 'interval', everyHours: 6, anchorAt: 0 })).toBe('Every 6 hours');
	});
});

describe('describeRun', () => {
	const run = (over: Partial<ScheduledRun>): ScheduledRun => ({
		id: 'r',
		scheduleId: 's',
		conversationId: null,
		slotAt: 0,
		trigger: 'schedule',
		state: 'done',
		failureKind: null,
		failureDetail: null,
		createdAt: 0,
		startedAt: null,
		finishedAt: null,
		...over,
	});

	it('says what went wrong, in its own words', () => {
		expect(
			describeRun(
				run({
					state: 'failed',
					failureKind: 'mcp_unavailable',
					failureDetail: 'Mail is unreachable',
				}),
			),
		).toEqual({ label: 'Mail is unreachable', tone: 'bad' });
	});

	it('marks waiting and stopped distinctly', () => {
		expect(describeRun(run({ state: 'needs_input' })).tone).toBe('warn');
		expect(describeRun(run({ state: 'skipped', failureKind: 'stopped' })).label).toBe('Stopped');
	});
});
