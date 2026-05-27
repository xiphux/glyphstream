import { describe, expect, it } from 'vitest';
import { clockTool } from '$lib/server/tools/clock';
import type { Tool, ToolContext, ToolExecution } from '$lib/server/tools/types';

function ctx(): ToolContext {
	return { userId: 'u1', conversationId: 'c1', signal: new AbortController().signal };
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
			additionalProperties: false
		});
	});

	it('defaults to UTC when no timezone is supplied', () => {
		const r = run(clockTool, {});
		expect(r.isError).toBeUndefined();
		const parsed = JSON.parse(r.content);
		expect(parsed.timezone).toBe('UTC');
		expect(typeof parsed.iso).toBe('string');
		expect(parsed.iso).toMatch(/Z$/);
		expect(typeof parsed.human).toBe('string');
		expect(parsed.human).toMatch(/UTC|Coordinated Universal Time/);
	});

	it('defaults to UTC when args is null or wrong type', () => {
		for (const args of [null, undefined, 'nope', 42]) {
			const r = run(clockTool, args);
			expect(r.isError).toBeUndefined();
			expect(JSON.parse(r.content).timezone).toBe('UTC');
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

	it('falls back to UTC for empty-string timezone', () => {
		const r = run(clockTool, { timezone: '' });
		expect(r.isError).toBeUndefined();
		expect(JSON.parse(r.content).timezone).toBe('UTC');
	});
});
