import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB }));
vi.mock('$lib/server/db/client', () => ({ getDb: () => mocks.testDb, closeDb: () => {} }));

import {
	createConversation,
	listConversationsNeedingSummary,
	listConversationSummariesForOverview,
	setConversationSummary,
} from '$lib/server/db/queries/conversations';
import {
	getConversationOverview,
	listUsersNeedingOverview,
	setConversationOverview,
} from '$lib/server/db/queries/users';
import { appendMessage } from '$lib/server/db/queries/messages';
import { searchConversations } from '$lib/server/db/queries/search';
import { conversations } from '$lib/server/db/schema';

const NOW = 10_000_000_000_000;
const SETTLE = 3_600_000; // 1h

beforeEach(() => {
	mocks.testDb = createTestDb();
});
afterEach(() => closeTestDb());

/** Seed a conversation with `messageCount` user messages, then force its
 *  updated_at (appendMessage's bump is overwritten so the test controls settle). */
function seedConv(
	userId: string,
	opts: { messages: number; updatedAt: number; title?: string },
): string {
	const conv = createConversation({
		userId,
		endpointId: 'bridge',
		modelId: 'bridge::x',
		modelKind: 'chat',
		title: opts.title ?? 'T',
	});
	let parent: string | null = null;
	for (let i = 0; i < opts.messages; i++) {
		const m = appendMessage({
			conversationId: conv.id,
			parentMessageId: parent,
			role: i % 2 === 0 ? 'user' : 'assistant',
			parts: [{ type: 'text', text: `message ${i} body` }],
		});
		parent = m.id;
	}
	mocks.testDb
		.update(conversations)
		.set({ updatedAt: opts.updatedAt })
		.where(eq(conversations.id, conv.id))
		.run();
	return conv.id;
}

function dueIds(): string[] {
	return listConversationsNeedingSummary(NOW, SETTLE, 50).map((c) => c.id);
}

describe('listConversationsNeedingSummary', () => {
	it('selects settled, ≥2-message, never-summarized conversations', () => {
		const u = seedUser();
		const settled = seedConv(u.id, { messages: 2, updatedAt: NOW - 2 * SETTLE });
		expect(dueIds()).toContain(settled);
	});

	it('excludes not-yet-settled (recently active) conversations', () => {
		const u = seedUser();
		const fresh = seedConv(u.id, { messages: 2, updatedAt: NOW - SETTLE / 2 });
		expect(dueIds()).not.toContain(fresh);
	});

	it('excludes single-message conversations', () => {
		const u = seedUser();
		const lonely = seedConv(u.id, { messages: 1, updatedAt: NOW - 2 * SETTLE });
		expect(dueIds()).not.toContain(lonely);
	});

	it('excludes a summarized + unchanged conversation, re-includes it after a change', () => {
		const u = seedUser();
		const c = seedConv(u.id, { messages: 2, updatedAt: NOW - 2 * SETTLE });
		setConversationSummary(c, 'a gist', NOW - 2 * SETTLE); // summarized_at == updated_at
		expect(dueIds()).not.toContain(c);

		// New activity bumps updated_at past summarized_at → due again (still settled).
		mocks.testDb
			.update(conversations)
			.set({ updatedAt: NOW - SETTLE - 1000 })
			.where(eq(conversations.id, c))
			.run();
		expect(dueIds()).toContain(c);
	});
});

describe('setConversationSummary', () => {
	it('writes summary + watermark WITHOUT bumping updated_at', () => {
		const u = seedUser();
		const c = seedConv(u.id, { messages: 2, updatedAt: NOW - 2 * SETTLE });
		setConversationSummary(c, 'the gist', NOW);
		const row = mocks.testDb
			.select({
				summary: conversations.summary,
				summarizedAt: conversations.summarizedAt,
				updatedAt: conversations.updatedAt,
			})
			.from(conversations)
			.where(eq(conversations.id, c))
			.get()!;
		expect(row.summary).toBe('the gist');
		expect(row.summarizedAt).toBe(NOW);
		expect(row.updatedAt).toBe(NOW - 2 * SETTLE); // untouched — the watermark guarantee
	});
});

describe('searchConversations + summary FTS integration', () => {
	it('surfaces a conversation by a gist term absent from every message, and carries the summary', () => {
		const u = seedUser();
		const c = seedConv(u.id, { messages: 2, updatedAt: NOW - 2 * SETTLE, title: 'Untitled-ish' });
		// "photosynthesis" appears in NO message body — only in the summary.
		setConversationSummary(c, 'Discussion about photosynthesis and plant biology.', NOW);

		const results = searchConversations(u.id, 'photosynthesis');
		expect(results.map((r) => r.conversationId)).toContain(c);
		const hit = results.find((r) => r.conversationId === c)!;
		expect(hit.kind).toBe('summary');
		expect(hit.summary).toBe('Discussion about photosynthesis and plant biology.');
	});

	it('a cleared (null) summary removes its FTS row', () => {
		const u = seedUser();
		const c = seedConv(u.id, { messages: 2, updatedAt: NOW - 2 * SETTLE });
		setConversationSummary(c, 'ephemeral pineapple gist', NOW);
		expect(searchConversations(u.id, 'pineapple').map((r) => r.conversationId)).toContain(c);
		setConversationSummary(c, null, NOW);
		expect(searchConversations(u.id, 'pineapple')).toEqual([]);
	});
});

describe('overview queries', () => {
	it('get/set round-trips the overview', () => {
		const u = seedUser();
		expect(getConversationOverview(u.id)).toBeNull();
		setConversationOverview(u.id, '## Topics\n- deploys', NOW);
		expect(getConversationOverview(u.id)).toBe('## Topics\n- deploys');
	});

	it('listConversationSummariesForOverview returns non-null summaries in created_at order', () => {
		const u = seedUser();
		// Seeded oldest-first; created_at is monotonic in seed order.
		const a = seedConv(u.id, { messages: 2, updatedAt: NOW });
		const b = seedConv(u.id, { messages: 2, updatedAt: NOW });
		const c = seedConv(u.id, { messages: 2, updatedAt: NOW });
		setConversationSummary(a, 'first gist', NOW);
		setConversationSummary(c, 'third gist', NOW);
		// b left unsummarized (null) → excluded.
		expect(listConversationSummariesForOverview(u.id)).toEqual(['first gist', 'third gist']);
		expect(b).toBeTruthy();
	});

	it('listUsersNeedingOverview picks changed users and skips settled/summary-less ones', () => {
		const u = seedUser();
		const noSummaries = seedUser();
		seedConv(noSummaries.id, { messages: 2, updatedAt: NOW }); // no summary → never due
		const conv = seedConv(u.id, { messages: 2, updatedAt: NOW });
		setConversationSummary(conv, 'a gist', NOW);

		// Has a summary, never built an overview → due; the summary-less user isn't.
		expect(listUsersNeedingOverview()).toContain(u.id);
		expect(listUsersNeedingOverview()).not.toContain(noSummaries.id);

		// Build the overview at/after the summary → settled.
		setConversationOverview(u.id, 'map', NOW);
		expect(listUsersNeedingOverview()).not.toContain(u.id);

		// A newer summary (re-summarized) re-flags the user.
		setConversationSummary(conv, 'a fresher gist', NOW + 1000);
		expect(listUsersNeedingOverview()).toContain(u.id);
	});
});
