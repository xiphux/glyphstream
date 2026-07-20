/**
 * The conversation-title task must acquire the endpoint's concurrency slot, so a
 * task model that shares a single-GPU chat endpoint serializes with live
 * generation instead of thrashing VRAM against it. (The relay releases its own
 * slot before the title race, so this never deadlocks behind a live turn.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({
	testDb: null as unknown as TestDB,
	chatCompletionSync: vi.fn(),
}));

vi.mock('$lib/server/db/client', () => ({ getDb: () => mocks.testDb, closeDb: () => {} }));
vi.mock('$lib/server/endpoints/client', async (orig) => ({
	...(await orig<typeof import('$lib/server/endpoints/client')>()),
	chatCompletionSync: mocks.chatCompletionSync,
}));

import { generateConversationTitle } from '$lib/server/tasks/title-generator';
import { createConversation } from '$lib/server/db/queries/conversations';
import { appendMessage } from '$lib/server/db/queries/messages';
import {
	acquireEndpointSlot,
	getEndpointQueueDepth,
	resetEndpointGatesForTests,
} from '$lib/server/endpoints/concurrency';
import type { LoadedEndpoint } from '$lib/server/endpoints/config';

beforeEach(() => {
	mocks.testDb = createTestDb();
	mocks.chatCompletionSync
		.mockReset()
		.mockResolvedValue({ choices: [{ message: { content: 'A Tidy Title' } }] });
});
afterEach(() => {
	closeTestDb();
	resetEndpointGatesForTests();
});

const soloEndpoint = (requestTimeoutSeconds = 120): LoadedEndpoint =>
	({
		id: 'solo',
		baseUrl: 'http://localhost/v1',
		apiKey: null,
		requestTimeoutSeconds,
		maxConcurrent: 1,
	}) as unknown as LoadedEndpoint;

function seedFirstExchange() {
	const u = seedUser();
	const conv = createConversation({
		userId: u.id,
		endpointId: 'solo',
		modelId: 'solo::chat',
		modelKind: 'chat',
	});
	const userMsg = appendMessage({
		conversationId: conv.id,
		parentMessageId: null,
		role: 'user',
		parts: [{ type: 'text', text: 'what is typescript?' }],
	});
	appendMessage({
		conversationId: conv.id,
		parentMessageId: userMsg.id,
		role: 'assistant',
		parts: [{ type: 'text', text: 'A typed superset of JavaScript.' }],
		modelUsed: 'solo::chat',
	});
	return { userId: u.id, convId: conv.id };
}

describe('title task — endpoint slot serialization', () => {
	it('waits on the endpoint slot before calling the task model, then proceeds once free', async () => {
		const { userId, convId } = seedFirstExchange();
		const taskModel = { endpoint: soloEndpoint(), upstreamId: 'title-model' };

		// Occupy the single slot on the shared endpoint.
		const held = await acquireEndpointSlot('solo', 1);

		const titlePromise = generateConversationTitle(convId, userId, { taskModel });
		// Give the title task a chance to run — it must be parked on the slot,
		// NOT calling the task model yet.
		await new Promise((r) => setTimeout(r, 10));
		expect(mocks.chatCompletionSync).not.toHaveBeenCalled();
		expect(getEndpointQueueDepth('solo')).toEqual({ active: 1, waiting: 1 });

		// Free the slot → the title task acquires it, calls the model, completes.
		held.release();
		const result = await titlePromise;
		expect(mocks.chatCompletionSync).toHaveBeenCalledTimes(1);
		expect(result?.title).toBe('A Tidy Title');
		// Slot released again after the task model call.
		expect(getEndpointQueueDepth('solo')).toEqual({ active: 0, waiting: 0 });
	});

	it('gives up (null) when the slot never frees within the request-timeout wait', async () => {
		const { userId, convId } = seedFirstExchange();
		// Tiny slot-wait bound (50ms) so the test doesn't hang on a held slot.
		const taskModel = { endpoint: soloEndpoint(0.05), upstreamId: 'title-model' };
		const held = await acquireEndpointSlot('solo', 1); // never released

		const result = await generateConversationTitle(convId, userId, { taskModel });
		// Couldn't get a slot in time → best-effort drop, no task-model call, and
		// the abandoned waiter was spliced out of the queue.
		expect(result).toBeNull();
		expect(mocks.chatCompletionSync).not.toHaveBeenCalled();
		expect(getEndpointQueueDepth('solo')).toEqual({ active: 1, waiting: 0 });
		held.release();
	});

	it('releases the slot even when the task model call throws', async () => {
		const { userId, convId } = seedFirstExchange();
		mocks.chatCompletionSync.mockRejectedValue(new Error('upstream boom'));
		const taskModel = { endpoint: soloEndpoint(), upstreamId: 'title-model' };

		const result = await generateConversationTitle(convId, userId, { taskModel });
		// Failure is non-fatal (null), and the slot must not leak.
		expect(result).toBeNull();
		expect(getEndpointQueueDepth('solo')).toEqual({ active: 0, waiting: 0 });
	});
});
