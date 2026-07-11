import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB }));
vi.mock('$lib/server/db/client', () => ({ getDb: () => mocks.testDb, closeDb: () => {} }));

const chatMock = vi.hoisted(() => vi.fn());
// Mock only the network call; keep the REAL UpstreamError + isPermanentRequestError
// so this worker test exercises the actual classifier it branches on and can't
// drift from it.
vi.mock('$lib/server/endpoints/client', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/endpoints/client')>();
	return { ...actual, chatCompletionSync: chatMock };
});

const memModelMock = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/tasks/memory-model', () => ({ getMemoryModel: memModelMock }));

const acquireMock = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/endpoints/concurrency', () => ({ acquireEndpointSlot: acquireMock }));

const listModelsMock = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/endpoints/list-models', () => ({ listAllModels: listModelsMock }));

import { runSummarySweep } from '$lib/server/memory/conversation-summary';
import { UpstreamError } from '$lib/server/endpoints/client';
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
	overviewMaxChars: 2500,
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

	it('ends the sweep on a transient UpstreamError (network / 5xx), leaving the watermark unadvanced', async () => {
		const u = seedUser();
		const c = seedConv(u.id);
		chatMock.mockRejectedValue(new UpstreamError('endpoint down', null, null)); // null status → transient
		expect(await runSummarySweep(NOW)).toEqual({ summarized: 0, overviewsUpdated: 0 });
		const row = summaryOf(c);
		expect(row.summary).toBeNull();
		expect(row.summarizedAt).toBeNull(); // unadvanced → retried next window

		chatMock.mockReset();
		chatMock.mockRejectedValue(new UpstreamError('upstream boom', 503, null)); // 5xx → transient
		expect(await runSummarySweep(NOW)).toEqual({ summarized: 0, overviewsUpdated: 0 });
		expect(summaryOf(c).summarizedAt).toBeNull();
	});

	it('ends the sweep on a systemic auth failure (401) instead of skipping every conversation', async () => {
		const u = seedUser();
		seedConv(u.id);
		seedConv(u.id);
		// Auth rejects EVERY request — skipping would burn the whole sweep on doomed
		// calls, so it aborts after the first like a transient outage.
		chatMock.mockRejectedValue(new UpstreamError('invalid api key', 401, null));
		expect(await runSummarySweep(NOW)).toEqual({ summarized: 0, overviewsUpdated: 0 });
		expect(chatMock).toHaveBeenCalledTimes(1); // bailed, did not try the second conversation
	});

	it('recovers a conversation the endpoint rejects as over-window, instead of skipping it', async () => {
		const u = seedUser();
		const c = seedConv(u.id);
		// llama.cpp's context-overflow 400, carrying its real numbers. The summarizer
		// re-runs against a budget corrected by them, so the conversation gets a
		// summary rather than being written off as un-summarizable.
		chatMock
			.mockRejectedValueOnce(
				new UpstreamError(
					'HTTP 400',
					400,
					JSON.stringify({
						error: {
							type: 'exceed_context_size_error',
							message: 'request (104317 tokens) exceeds the available context size (98304 tokens)',
							n_prompt_tokens: 104317,
							n_ctx: 98304,
						},
					}),
				),
			)
			.mockResolvedValue({ choices: [{ message: { content: 'A gist of the chat.' } }] });

		expect(await runSummarySweep(NOW)).toEqual({ summarized: 1, overviewsUpdated: 1 });
		const row = summaryOf(c);
		expect(row.summary).toBe('A gist of the chat.');
		expect(row.summarizedAt).toBe(NOW);
	});

	it('skips a conversation the endpoint permanently rejects and keeps sweeping the rest', async () => {
		const u = seedUser();
		const c1 = seedConv(u.id);
		const c2 = seedConv(u.id);
		// A permanent, request-specific 400 that shrinking cannot fix. The next
		// conversation (and the overview build) still succeed — the old behavior bailed
		// the whole sweep here, wedging the oldest-first backlog behind one bad chat.
		chatMock
			.mockRejectedValueOnce(new UpstreamError('unsupported input', 400, null))
			.mockResolvedValue({ choices: [{ message: { content: 'A gist of the chat.' } }] });

		expect(await runSummarySweep(NOW)).toEqual({ summarized: 1, overviewsUpdated: 1 });

		const rows = [summaryOf(c1), summaryOf(c2)];
		const done = rows.filter((r) => r.summary !== null);
		const skipped = rows.filter((r) => r.summary === null);
		// One conversation summarized despite the other permanently failing.
		expect(done).toHaveLength(1);
		expect(done[0].summarizedAt).toBe(NOW);
		// The skipped one is left unadvanced so it retries next sweep, not stamped-as-done.
		expect(skipped).toHaveLength(1);
		expect(skipped[0].summarizedAt).toBeNull();
	});
});
