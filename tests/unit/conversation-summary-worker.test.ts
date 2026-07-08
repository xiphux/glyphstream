import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB }));
vi.mock('$lib/server/db/client', () => ({ getDb: () => mocks.testDb, closeDb: () => {} }));

const chatMock = vi.hoisted(() => vi.fn());
const FakeUpstreamError = vi.hoisted(() => class UpstreamError extends Error {});
vi.mock('$lib/server/endpoints/client', () => ({
	chatCompletionSync: chatMock,
	UpstreamError: FakeUpstreamError,
}));

const memModelMock = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/tasks/memory-model', () => ({ getMemoryModel: memModelMock }));

const acquireMock = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/endpoints/concurrency', () => ({ acquireEndpointSlot: acquireMock }));

const listModelsMock = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/endpoints/list-models', () => ({ listAllModels: listModelsMock }));

import { runSummarySweep } from '$lib/server/memory/conversation-summary';
import { createConversation } from '$lib/server/db/queries/conversations';
import { getConversationOverview } from '$lib/server/db/queries/users';
import { appendMessage } from '$lib/server/db/queries/messages';
import { conversations } from '$lib/server/db/schema';

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0); // noon UTC — a fixed instant for window tests
const SETTLE = 60 * 60 * 1000;

const MODEL = {
	endpoint: { id: 'gpu', maxConcurrent: 1 },
	upstreamId: 'm',
	maxTokens: 500,
	temperature: 0.2,
	activeHours: '',
	timezone: 'UTC',
};

beforeEach(() => {
	mocks.testDb = createTestDb();
	chatMock.mockReset();
	memModelMock.mockReset();
	acquireMock.mockReset();
	listModelsMock.mockReset();
	memModelMock.mockReturnValue(MODEL);
	acquireMock.mockResolvedValue({ release: vi.fn() });
	listModelsMock.mockResolvedValue([]); // contextWindow unresolved → summarizer default
	chatMock.mockResolvedValue({ choices: [{ message: { content: 'A gist of the chat.' } }] });
});
afterEach(() => closeTestDb());

function seedConv(userId: string, textParts = true): string {
	const conv = createConversation({
		userId,
		endpointId: 'bridge',
		modelId: 'bridge::x',
		modelKind: 'chat',
		title: 'T',
	});
	let parent: string | null = null;
	for (let i = 0; i < 2; i++) {
		const m = appendMessage({
			conversationId: conv.id,
			parentMessageId: parent,
			role: i % 2 === 0 ? 'user' : 'assistant',
			parts: textParts ? [{ type: 'text', text: `body ${i}` }] : [{ type: 'text', text: '' }],
		});
		parent = m.id;
	}
	// Settle it well before NOW so it's due.
	mocks.testDb
		.update(conversations)
		.set({ updatedAt: NOW - 2 * SETTLE })
		.where(eq(conversations.id, conv.id))
		.run();
	return conv.id;
}

function summaryOf(id: string) {
	return mocks.testDb
		.select({ summary: conversations.summary, summarizedAt: conversations.summarizedAt })
		.from(conversations)
		.where(eq(conversations.id, id))
		.get()!;
}

describe('runSummarySweep', () => {
	it('no-ops when no memory model is configured', async () => {
		memModelMock.mockReturnValue(null);
		seedConv(seedUser().id);
		expect(await runSummarySweep(NOW)).toEqual({ summarized: 0, overviewsUpdated: 0 });
		expect(chatMock).not.toHaveBeenCalled();
	});

	it('no-ops outside the active-hours window', async () => {
		memModelMock.mockReturnValue({ ...MODEL, activeHours: '02:00-03:00', timezone: 'UTC' });
		seedConv(seedUser().id);
		expect(await runSummarySweep(NOW)).toEqual({ summarized: 0, overviewsUpdated: 0 }); // NOW is noon UTC, outside 02-03
		expect(chatMock).not.toHaveBeenCalled();
	});

	it('summarizes a due conversation + rebuilds the overview, and re-does neither next sweep', async () => {
		const u = seedUser();
		const c = seedConv(u.id);

		expect(await runSummarySweep(NOW)).toEqual({ summarized: 1, overviewsUpdated: 1 });
		const row = summaryOf(c);
		expect(row.summary).toBe('A gist of the chat.');
		expect(row.summarizedAt).toBe(NOW);
		// Overview built for the user + watermark advanced.
		expect(getConversationOverview(u.id)).toBe('A gist of the chat.');

		// Settled + summarized + overview current → a second sweep is a full no-op.
		chatMock.mockClear();
		expect(await runSummarySweep(NOW)).toEqual({ summarized: 0, overviewsUpdated: 0 });
		expect(chatMock).not.toHaveBeenCalled();
	});

	it('stamps a null summary (not re-picked) when there is nothing to summarize', async () => {
		const u = seedUser();
		const c = seedConv(u.id, false); // empty text → empty transcript
		// No non-null summary → no overview either.
		expect(await runSummarySweep(NOW)).toEqual({ summarized: 0, overviewsUpdated: 0 });
		expect(chatMock).not.toHaveBeenCalled(); // short-circuited before the model
		const row = summaryOf(c);
		expect(row.summary).toBeNull();
		expect(row.summarizedAt).toBe(NOW); // watermark advanced so it isn't reconsidered
	});

	it('ends the sweep on an UpstreamError, leaving the watermark unadvanced', async () => {
		const u = seedUser();
		const c = seedConv(u.id);
		chatMock.mockRejectedValue(new FakeUpstreamError('endpoint down'));
		expect(await runSummarySweep(NOW)).toEqual({ summarized: 0, overviewsUpdated: 0 });
		const row = summaryOf(c);
		expect(row.summary).toBeNull();
		expect(row.summarizedAt).toBeNull(); // unadvanced → retried next window
	});
});
