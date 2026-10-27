import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	DEFAULT_SCHEDULED_TASKS_CONFIG,
	loadCheckInsConfig,
	loadScheduledTasksConfig,
} from '#lib/server/endpoints/config.js';

const tmpDirs: string[] = [];
function writeConfig(toml: string): string {
	const dir = mkdtempSync(join(tmpdir(), 'gs-config-'));
	tmpDirs.push(dir);
	const path = join(dir, 'config.toml');
	writeFileSync(path, toml);
	return path;
}
afterEach(() => {
	while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe('loadScheduledTasksConfig', () => {
	it('defaults everything when the table is absent', () => {
		expect(loadScheduledTasksConfig(writeConfig(''))).toEqual(DEFAULT_SCHEDULED_TASKS_CONFIG);
	});

	it('reads every key', () => {
		const path = writeConfig(`[scheduled_tasks]
enabled = false
max_per_user = 5
min_interval_hours = 6
default_deadline_minutes = 30
keep_runs = 10
disable_after_failures = 2
`);
		expect(loadScheduledTasksConfig(path)).toEqual({
			enabled: false,
			maxPerUser: 5,
			minIntervalHours: 6,
			defaultDeadlineMinutes: 30,
			keepRuns: 10,
			disableAfterFailures: 2,
		});
	});

	it.each([
		['enabled = "yes"', /boolean/],
		['max_per_user = 0', />= 1/],
		['min_interval_hours = 1.5', /integer/],
		['default_deadline_minutes = 1', />= 5/],
		['keep_runs = 0', />= 1/],
		['keep_run = 3', /unknown key 'keep_run'/],
	])('rejects %s', (line, message) => {
		expect(() => loadScheduledTasksConfig(writeConfig(`[scheduled_tasks]\n${line}\n`))).toThrow(
			message,
		);
	});
});

describe('loadCheckInsConfig', () => {
	it('is on unless turned off', () => {
		expect(loadCheckInsConfig(writeConfig(''))).toEqual({ enabled: true });
		expect(loadCheckInsConfig(writeConfig('[check_ins]\nenabled = false\n'))).toEqual({
			enabled: false,
		});
	});

	it.each([
		['enabled = 1', /boolean/],
		['enable = true', /unknown key 'enable'/],
	])('rejects %s', (line, message) => {
		expect(() => loadCheckInsConfig(writeConfig(`[check_ins]\n${line}\n`))).toThrow(message);
	});
});
