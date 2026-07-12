import { beforeEach, describe, expect, it, vi } from 'vitest';

// The tool resolves its DEFAULT zone from the caller's stored preferences (see
// `parseTimezone` in clock.ts), so the prefs lookup is the thing under control
// here — not the database.
const mocks = vi.hoisted(() => ({ timezone: null as string | null }));
vi.mock('$lib/server/db/queries/user-preferences', () => ({
	getUserPreferences: () => ({ timezone: mocks.timezone }),
}));

import { clockTool } from '$lib/server/tools/clock';
import type { Tool, ToolContext, ToolExecution } from '$lib/server/tools/types';

/** The server's own zone — what the tool falls back to when the user has never
 *  had a browser report one. */
const SERVER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

beforeEach(() => {
	mocks.timezone = null;
});

function ctx(): ToolContext {
	return {
		userId: 'u1',
		conversationId: 'c1',
		signal: new AbortController().signal,
		disabledFeatures: [],
	};
}

function run(t: Tool, args: unknown): ToolExecution {
	const r = t.execute(args, ctx());
	if (r instanceof Promise) throw new Error('clock should be synchronous');
	return r;
}

describe('get_current_time', () => {
	it('has the expected OpenAI tool definition', () => {
		expect(clockTool.definition.function.name).toBe('get_current_time');
		expect(clockTool.definition.function.parameters).toMatchObject({
			type: 'object',
			properties: { timezone: { type: 'string' } },
			additionalProperties: false,
		});
	});

	it("defaults to the USER's timezone when none is supplied", () => {
		// It used to default to UTC, which made "what time is it?" wrong for almost
		// everyone: the model has no way to know the user's zone unless we tell it,
		// so it was never going to pass one — and UTC is nobody's wall clock.
		mocks.timezone = 'America/Chicago';
		const r = run(clockTool, {});
		expect(r.isError).toBeUndefined();
		const parsed = JSON.parse(r.content);
		expect(parsed.timezone).toBe('America/Chicago');
		expect(typeof parsed.iso).toBe('string');
		expect(parsed.iso).toMatch(/Z$/);
		expect(typeof parsed.human).toBe('string');
	});

	it('falls back to the server zone when the user has no stored timezone', () => {
		mocks.timezone = null;
		expect(JSON.parse(run(clockTool, {}).content).timezone).toBe(SERVER_TZ);
	});

	it('falls back rather than throwing when the stored timezone is unresolvable', () => {
		// A zone retired by an ICU update would otherwise make Intl throw inside a
		// tool call.
		mocks.timezone = 'Mars/Olympus_Mons';
		const r = run(clockTool, {});
		expect(r.isError).toBeUndefined();
		expect(JSON.parse(r.content).timezone).toBe(SERVER_TZ);
	});

	it("defaults to the user's timezone when args is null or wrong type", () => {
		mocks.timezone = 'Asia/Tokyo';
		for (const args of [null, undefined, 'nope', 42]) {
			const r = run(clockTool, args);
			expect(r.isError).toBeUndefined();
			expect(JSON.parse(r.content).timezone).toBe('Asia/Tokyo');
		}
	});

	it('formats time in a valid IANA timezone', () => {
		const r = run(clockTool, { timezone: 'America/New_York' });
		expect(r.isError).toBeUndefined();
		const parsed = JSON.parse(r.content);
		expect(parsed.timezone).toBe('America/New_York');
		expect(parsed.human).toMatch(/E[SD]T|Eastern/);
	});

	it('returns isError for an invalid IANA timezone', () => {
		const r = run(clockTool, { timezone: 'Fake/Nowhere' });
		expect(r.isError).toBe(true);
		expect(JSON.parse(r.content).error).toMatch(/Unknown IANA timezone/);
		expect(JSON.parse(r.content).error).toContain('Fake/Nowhere');
	});

	it("falls back to the user's timezone for an empty-string timezone arg", () => {
		mocks.timezone = 'Europe/London';
		const r = run(clockTool, { timezone: '' });
		expect(r.isError).toBeUndefined();
		expect(JSON.parse(r.content).timezone).toBe('Europe/London');
	});
});
