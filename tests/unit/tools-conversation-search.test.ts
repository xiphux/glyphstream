import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB }));
vi.mock('$lib/server/db/client', () => ({
	getDb: () => mocks.testDb,
	closeDb: () => {},
}));

// Importing the tool module registers `search_conversations` in the singleton
// registry (vitest isolates the module graph per file, so it's a clean registry).
import {
	searchConversationsTool,
	timeRangeToCutoff,
	excerptAround,
} from '$lib/server/tools/conversation-search';
import { openaiToolDefinitions } from '$lib/server/tools/registry';
import { createConversation, setConversationSummary } from '$lib/server/db/queries/conversations';
import { appendMessage } from '$lib/server/db/queries/messages';
import { conversations } from '$lib/server/db/schema';
import type { Tool, ToolContext, ToolExecution } from '$lib/server/tools/types';

function ctx(userId: string, conversationId = 'current'): ToolContext {
	return { userId, conversationId, signal: new AbortController().signal, disabledFeatures: [] };
}

function run(t: Tool, args: unknown, c: ToolContext): ToolExecution {
	const r = t.execute(args, c);
	if (r instanceof Promise) throw new Error('search_conversations should be synchronous');
	return r;
}

function newConv(userId: string, title: string, isPrivate = false) {
	return createConversation({
		userId,
		endpointId: 'bridge',
		modelId: 'bridge::x',
		modelKind: 'chat',
		title,
		private: isPrivate,
	});
}

/** Seed a conversation with one user message so the FTS triggers index its body. */
function seedConv(userId: string, title: string, text: string, isPrivate = false): string {
	const conv = newConv(userId, title, isPrivate);
	appendMessage({
		conversationId: conv.id,
		parentMessageId: null,
		role: 'user',
		parts: [{ type: 'text', text }],
	});
	return conv.id;
}

/** Force a conversation's updated_at (for the time_range filter test). */
function backdate(convId: string, updatedAt: number) {
	mocks.testDb.update(conversations).set({ updatedAt }).where(eq(conversations.id, convId)).run();
}

beforeEach(() => {
	mocks.testDb = createTestDb();
});

afterEach(() => {
	closeTestDb();
});

describe('timeRangeToCutoff', () => {
	it('maps each window to now minus its duration', () => {
		const now = 1_000_000_000_000;
		expect(timeRangeToCutoff('day', now)).toBe(now - 24 * 60 * 60 * 1000);
		expect(timeRangeToCutoff('week', now)).toBe(now - 7 * 24 * 60 * 60 * 1000);
		expect(timeRangeToCutoff('month', now)).toBe(now - 30 * 24 * 60 * 60 * 1000);
		expect(timeRangeToCutoff('year', now)).toBe(now - 365 * 24 * 60 * 60 * 1000);
	});
});

describe('excerptAround', () => {
	it('returns short text whole', () => {
		expect(excerptAround('a short body', ['short'], 800)).toBe('a short body');
	});

	it('centers a capped window on the earliest matching token', () => {
		const body = 'x'.repeat(500) + ' NEEDLE ' + 'y'.repeat(500);
		const out = excerptAround(body, ['needle'], 100);
		expect(out.length).toBeLessThanOrEqual(102); // cap + the two ellipses
		expect(out).toContain('NEEDLE');
		expect(out.startsWith('…')).toBe(true);
		expect(out.endsWith('…')).toBe(true);
	});

	it('falls back to the head when no token is found', () => {
		const body = 'z'.repeat(2000);
		const out = excerptAround(body, ['absent'], 100);
		expect(out.length).toBe(101); // 100 + trailing ellipsis
		expect(out.endsWith('…')).toBe(true);
	});
});

describe('search_conversations.execute', () => {
	it('finds a past conversation and returns its title + matched message text', () => {
		const u = seedUser();
		seedConv(u.id, 'Deploy planning', 'We decided to use blue-green deploys for the API.');

		const r = run(searchConversationsTool, { query: 'blue-green deploys' }, ctx(u.id));
		expect(r.isError).toBeUndefined();
		const { results } = JSON.parse(r.content);
		expect(results).toHaveLength(1);
		expect(results[0].title).toBe('Deploy planning');
		expect(results[0].text).toContain('blue-green');
	});

	it('excludes the current conversation from results', () => {
		const u = seedUser();
		const currentId = seedConv(u.id, 'Current thread', 'talking about widgets right now');
		seedConv(u.id, 'Older thread', 'we also discussed widgets last month');

		const r = run(searchConversationsTool, { query: 'widgets' }, ctx(u.id, currentId));
		const { results } = JSON.parse(r.content);
		// Only the older thread — the current one is filtered even though it matches.
		const ids = results.map((x: { conversationId: string }) => x.conversationId);
		expect(ids).not.toContain(currentId);
		expect(results).toHaveLength(1);
		expect(results[0].title).toBe('Older thread');
	});

	it('carries the conversation gist (summary) in each result', () => {
		const u = seedUser();
		const c = seedConv(u.id, 'Deploy planning', 'We shipped the API.');
		setConversationSummary(c, 'Planned and shipped the API deploy.', Date.now());
		const r = run(searchConversationsTool, { query: 'API' }, ctx(u.id));
		const { results } = JSON.parse(r.content);
		expect(results.find((x: { conversationId: string }) => x.conversationId === c).summary).toBe(
			'Planned and shipped the API deploy.',
		);
	});

	it('respects the time_range recency filter', () => {
		const u = seedUser();
		const old = seedConv(u.id, 'Ancient', 'kubernetes migration notes');
		seedConv(u.id, 'Recent', 'kubernetes migration follow-up');
		// Push the "Ancient" conversation ten days back — outside a one-week window.
		backdate(old, Date.now() - 10 * 24 * 60 * 60 * 1000);

		const r = run(searchConversationsTool, { query: 'kubernetes', time_range: 'week' }, ctx(u.id));
		const { results } = JSON.parse(r.content);
		expect(results).toHaveLength(1);
		expect(results[0].title).toBe('Recent');
	});

	it('never returns a private conversation’s content (the content seal)', () => {
		const u = seedUser();
		// A private chat matching the query, plus a normal one that also matches.
		seedConv(u.id, 'Secret roleplay', 'the dragon guards the pineapple hoard', true);
		const normal = seedConv(u.id, 'Trip notes', 'we ate pineapple in Hawaii');

		const r = run(searchConversationsTool, { query: 'pineapple' }, ctx(u.id));
		const { results } = JSON.parse(r.content);
		// Only the normal conversation — the private one is sealed even though it
		// matches and belongs to the same user (the tool passes excludePrivate).
		expect(results).toHaveLength(1);
		expect(results[0].conversationId).toBe(normal);
	});

	it('never returns another user’s conversations (user scoping)', () => {
		const u1 = seedUser();
		const u2 = seedUser();
		seedConv(u2.id, 'u2 private', 'u2 secret pineapple plans');

		const r = run(searchConversationsTool, { query: 'pineapple' }, ctx(u1.id));
		expect(JSON.parse(r.content).results).toEqual([]);
	});

	it('returns results:[] (not an error) for an empty query', () => {
		const u = seedUser();
		seedConv(u.id, 'Something', 'anything at all');
		const r = run(searchConversationsTool, { query: '   ' }, ctx(u.id));
		expect(r.isError).toBeUndefined();
		expect(JSON.parse(r.content).results).toEqual([]);
	});

	it('errors on a missing / non-string query', () => {
		const u = seedUser();
		expect(run(searchConversationsTool, {}, ctx(u.id)).isError).toBe(true);
		expect(run(searchConversationsTool, { query: 42 }, ctx(u.id)).isError).toBe(true);
	});

	it('rejects an invalid time_range', () => {
		const u = seedUser();
		const r = run(searchConversationsTool, { query: 'x', time_range: 'fortnight' }, ctx(u.id));
		expect(r.isError).toBe(true);
	});
});

describe('personalization category gate', () => {
	it('search_conversations is advertised by default', () => {
		const names = openaiToolDefinitions().map((d) => d.function.name);
		expect(names).toContain('search_conversations');
	});

	it('is filtered out when personalization is excluded', () => {
		// The same seal as the memory tools: toggling personalization off means the
		// model never sees conversation search advertised, so it can't recall past
		// conversation content.
		const names = openaiToolDefinitions({ excludeCategories: ['personalization'] }).map(
			(d) => d.function.name,
		);
		expect(names).not.toContain('search_conversations');
	});

	it('excluding `web` alone does not filter it', () => {
		const names = openaiToolDefinitions({ excludeCategories: ['web'] }).map((d) => d.function.name);
		expect(names).toContain('search_conversations');
	});
});
