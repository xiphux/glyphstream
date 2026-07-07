import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB }));
vi.mock('$lib/server/db/client', () => ({
	getDb: () => mocks.testDb,
	closeDb: () => {},
}));

// Import the tool module for its side-effect registration in the singleton
// registry, AND the per-tool exports we want to invoke directly.
import { saveMemoryTool, updateMemoryTool, forgetMemoryTool } from '$lib/server/tools/memory';
import { openaiToolDefinitions } from '$lib/server/tools/registry';
import { MEMORY_MAX_CONTENT_CHARS } from '$lib/server/memory/limits';
import { listMemoriesForUser } from '$lib/server/db/queries/memories';
import type { Tool, ToolContext, ToolExecution } from '$lib/server/tools/types';

function ctx(userId: string): ToolContext {
	return {
		userId,
		conversationId: 'c1',
		signal: new AbortController().signal,
		disabledFeatures: [],
	};
}

function run(t: Tool, args: unknown, c: ToolContext): ToolExecution {
	const r = t.execute(args, c);
	if (r instanceof Promise) throw new Error('memory tools should be synchronous');
	return r;
}

beforeEach(() => {
	mocks.testDb = createTestDb();
});

afterEach(() => {
	closeTestDb();
});

describe('memory tool definitions + metadata', () => {
	it('all three carry category: personalization', () => {
		// Same toggle that gates the persona prompt also seals memory access.
		expect(saveMemoryTool.metadata?.category).toBe('personalization');
		expect(updateMemoryTool.metadata?.category).toBe('personalization');
		expect(forgetMemoryTool.metadata?.category).toBe('personalization');
	});

	it('have the expected function names', () => {
		expect(saveMemoryTool.definition.function.name).toBe('save_memory');
		expect(updateMemoryTool.definition.function.name).toBe('update_memory');
		expect(forgetMemoryTool.definition.function.name).toBe('forget_memory');
	});

	it('save_memory requires content + topic', () => {
		expect(saveMemoryTool.definition.function.parameters).toMatchObject({
			required: ['content', 'topic'],
		});
	});

	it('update_memory requires id + content + topic', () => {
		expect(updateMemoryTool.definition.function.parameters).toMatchObject({
			required: ['id', 'content', 'topic'],
		});
	});

	it('forget_memory requires id', () => {
		expect(forgetMemoryTool.definition.function.parameters).toMatchObject({
			required: ['id'],
		});
	});
});

describe('save_memory.execute', () => {
	it('persists the memory + topic and returns its id', () => {
		const u = seedUser();
		const r = run(saveMemoryTool, { content: 'prefers metric units', topic: 'Units' }, ctx(u.id));
		expect(r.isError).toBeUndefined();
		const parsed = JSON.parse(r.content);
		expect(parsed.saved).toBe(true);
		expect(typeof parsed.id).toBe('string');
		const list = listMemoriesForUser(u.id);
		expect(list).toHaveLength(1);
		expect(list[0].id).toBe(parsed.id);
		expect(list[0].content).toBe('prefers metric units');
	});

	it('trims whitespace from content and topic', () => {
		const u = seedUser();
		run(saveMemoryTool, { content: '   padded   ', topic: '  Units  ' }, ctx(u.id));
		expect(listMemoriesForUser(u.id)[0].content).toBe('padded');
	});

	it('returns isError for missing / non-string content', () => {
		const u = seedUser();
		expect(run(saveMemoryTool, { topic: 'T' }, ctx(u.id)).isError).toBe(true);
		expect(run(saveMemoryTool, { content: 42, topic: 'T' }, ctx(u.id)).isError).toBe(true);
		expect(run(saveMemoryTool, null, ctx(u.id)).isError).toBe(true);
		// Nothing was saved across the error cases.
		expect(listMemoriesForUser(u.id)).toEqual([]);
	});

	it('returns isError for a missing / empty topic', () => {
		const u = seedUser();
		expect(run(saveMemoryTool, { content: 'fact' }, ctx(u.id)).isError).toBe(true);
		expect(run(saveMemoryTool, { content: 'fact', topic: '' }, ctx(u.id)).isError).toBe(true);
		expect(run(saveMemoryTool, { content: 'fact', topic: '   ' }, ctx(u.id)).isError).toBe(true);
		expect(listMemoriesForUser(u.id)).toEqual([]);
	});

	it('returns isError for empty content', () => {
		const u = seedUser();
		expect(run(saveMemoryTool, { content: '', topic: 'T' }, ctx(u.id)).isError).toBe(true);
		expect(run(saveMemoryTool, { content: '   ', topic: 'T' }, ctx(u.id)).isError).toBe(true);
	});

	it('returns isError for over-long content', () => {
		const u = seedUser();
		const tooLong = 'x'.repeat(MEMORY_MAX_CONTENT_CHARS + 1);
		const r = run(saveMemoryTool, { content: tooLong, topic: 'T' }, ctx(u.id));
		expect(r.isError).toBe(true);
		expect(JSON.parse(r.content).error).toMatch(/exceeds/);
	});

	it('accepts a richer multi-sentence body within the cap', () => {
		const u = seedUser();
		const rich =
			'Prefers metric units, and gets frustrated when technical docs use imperial. ' +
			'Worth converting proactively in any engineering context.';
		expect(rich.length).toBeLessThanOrEqual(MEMORY_MAX_CONTENT_CHARS);
		const r = run(saveMemoryTool, { content: rich, topic: 'Units' }, ctx(u.id));
		expect(r.isError).toBeUndefined();
		expect(listMemoriesForUser(u.id)[0].content).toBe(rich);
	});

	it('normalizes internal newlines/whitespace so a paragraph stays single-line', () => {
		const u = seedUser();
		// A "short paragraph" the model might write with hard line breaks — stored
		// collapsed to single spaces so the [id] content render stays one line.
		run(
			saveMemoryTool,
			{ content: 'First sentence.\nSecond sentence.\n\n  Third.', topic: 'T' },
			ctx(u.id),
		);
		const stored = listMemoriesForUser(u.id)[0].content;
		expect(stored).toBe('First sentence. Second sentence. Third.');
		expect(stored).not.toContain('\n');
	});
});

describe('update_memory.execute', () => {
	it('replaces content for a valid id', () => {
		const u = seedUser();
		const saved = JSON.parse(
			run(saveMemoryTool, { content: 'original', topic: 'T' }, ctx(u.id)).content,
		);
		const r = run(updateMemoryTool, { id: saved.id, content: 'revised', topic: 'T2' }, ctx(u.id));
		expect(r.isError).toBeUndefined();
		expect(JSON.parse(r.content)).toMatchObject({ id: saved.id, updated: true });
		expect(listMemoriesForUser(u.id)[0].content).toBe('revised');
	});

	it('returns isError for an unknown id without throwing', () => {
		const u = seedUser();
		const r = run(updateMemoryTool, { id: 'nope', content: 'x', topic: 'T' }, ctx(u.id));
		expect(r.isError).toBe(true);
		expect(JSON.parse(r.content).error).toMatch(/No memory with id/);
	});

	it('returns isError when the id belongs to another user', () => {
		const u1 = seedUser();
		const u2 = seedUser();
		const saved = JSON.parse(
			run(saveMemoryTool, { content: 'u1 fact', topic: 'T' }, ctx(u1.id)).content,
		);
		// u2 tries to update u1's memory — must surface as a tool error
		// and leave u1's row untouched.
		const r = run(updateMemoryTool, { id: saved.id, content: 'pwn', topic: 'T' }, ctx(u2.id));
		expect(r.isError).toBe(true);
		expect(listMemoriesForUser(u1.id)[0].content).toBe('u1 fact');
	});

	it('returns isError when id, content, or topic is missing', () => {
		const u = seedUser();
		expect(run(updateMemoryTool, { content: 'x', topic: 'T' }, ctx(u.id)).isError).toBe(true);
		expect(run(updateMemoryTool, { id: 'x', topic: 'T' }, ctx(u.id)).isError).toBe(true);
		expect(run(updateMemoryTool, { id: 'x', content: 'y' }, ctx(u.id)).isError).toBe(true);
	});
});

describe('personalization category gate', () => {
	const MEMORY_TOOL_NAMES = ['save_memory', 'update_memory', 'forget_memory'];

	it('memory tools appear in advertised tools by default', () => {
		const names = openaiToolDefinitions().map((d) => d.function.name);
		for (const t of MEMORY_TOOL_NAMES) {
			expect(names).toContain(t);
		}
	});

	it('memory tools are filtered out when personalization is excluded', () => {
		// This is the gate that seals the model's write path when the user
		// toggles personalization off on a conversation — without the model
		// even seeing the tools advertised, it cannot "discover" and call
		// them.
		const names = openaiToolDefinitions({ excludeCategories: ['personalization'] }).map(
			(d) => d.function.name,
		);
		for (const t of MEMORY_TOOL_NAMES) {
			expect(names).not.toContain(t);
		}
	});

	it('excluding `web` alone does not filter memory tools', () => {
		const names = openaiToolDefinitions({ excludeCategories: ['web'] }).map((d) => d.function.name);
		for (const t of MEMORY_TOOL_NAMES) {
			expect(names).toContain(t);
		}
	});
});

describe('forget_memory.execute', () => {
	it('removes the row for a valid id', () => {
		const u = seedUser();
		const saved = JSON.parse(
			run(saveMemoryTool, { content: 'fact', topic: 'T' }, ctx(u.id)).content,
		);
		const r = run(forgetMemoryTool, { id: saved.id }, ctx(u.id));
		expect(r.isError).toBeUndefined();
		expect(JSON.parse(r.content)).toMatchObject({ id: saved.id, forgotten: true });
		expect(listMemoriesForUser(u.id)).toEqual([]);
	});

	it('returns isError for an unknown id', () => {
		const u = seedUser();
		const r = run(forgetMemoryTool, { id: 'nope' }, ctx(u.id));
		expect(r.isError).toBe(true);
	});

	it('returns isError when the id belongs to another user', () => {
		const u1 = seedUser();
		const u2 = seedUser();
		const saved = JSON.parse(
			run(saveMemoryTool, { content: 'u1 fact', topic: 'T' }, ctx(u1.id)).content,
		);
		const r = run(forgetMemoryTool, { id: saved.id }, ctx(u2.id));
		expect(r.isError).toBe(true);
		expect(listMemoriesForUser(u1.id)).toHaveLength(1);
	});
});
