/**
 * Unit tests for the streaming image relay — the sole image-generation path
 * (single send + every fan-out branch). Exercises the SSE event sequence
 * (queued → start → done / error), the in-flight timer-stamp (onStarted), the
 * fan-out active_leaf pinning, and the server-side regenerate delete — all
 * against a real in-memory DB with the upstream client + persister mocked.
 *
 * Modeled on relay-tool-loop.test.ts: real test DB + gate, mocked side-effects.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({
	testDb: null as unknown as TestDB,
	imageGeneration: vi.fn(),
	imageEdit: vi.fn(),
	persistGeneratedImage: vi.fn(),
	linkMessageMedia: vi.fn(),
	loadMediaBytes: vi.fn(),
	unlinkMediaFiles: vi.fn(async () => {}),
}));

vi.mock('$lib/server/db/client', () => ({ getDb: () => mocks.testDb, closeDb: () => {} }));
vi.mock('$lib/server/endpoints/client', async (orig) => ({
	...(await orig<typeof import('$lib/server/endpoints/client')>()),
	imageGeneration: mocks.imageGeneration,
	imageEdit: mocks.imageEdit,
}));
vi.mock('$lib/server/media/persister', () => ({
	persistGeneratedImage: mocks.persistGeneratedImage,
}));
vi.mock('$lib/server/db/queries/media', async (orig) => ({
	...(await orig<typeof import('$lib/server/db/queries/media')>()),
	linkMessageMedia: mocks.linkMessageMedia,
}));
vi.mock('$lib/server/media/data-url', () => ({
	loadMediaBytes: mocks.loadMediaBytes,
}));
vi.mock('$lib/server/media/disk-store', () => ({
	unlinkMediaFiles: mocks.unlinkMediaFiles,
}));
vi.mock('$lib/server/push/notify', () => ({ notifyConversationComplete: vi.fn(async () => {}) }));
vi.mock('$lib/server/tasks/title-task-runner', () => ({
	startTitleTaskIfFirstExchange: vi.fn(() => Promise.resolve(null)),
	raceTitle: vi.fn(async (p: Promise<string | null>) => p),
}));

import { createConversation, getConversationDetail } from '$lib/server/db/queries/conversations';
import { appendMessage, getMessage, getSiblingAssistants } from '$lib/server/db/queries/messages';
import { startImageRelay, type ImageRelayParams } from '$lib/server/streaming/image-relay';
import { acquireEndpointSlot, resetEndpointGatesForTests } from '$lib/server/endpoints/concurrency';
import type { LoadedEndpoint } from '$lib/server/endpoints/config';
import type { ChatMessage, StreamEvent } from '$lib/types/api';

beforeEach(() => {
	mocks.testDb = createTestDb();
	mocks.imageGeneration.mockReset();
	mocks.imageEdit.mockReset();
	mocks.persistGeneratedImage.mockReset().mockResolvedValue('media-out');
	mocks.linkMessageMedia.mockReset();
	mocks.loadMediaBytes.mockReset();
	mocks.unlinkMediaFiles.mockReset().mockResolvedValue(undefined);
	mocks.imageGeneration.mockResolvedValue({ data: [{ url: 'http://img/out.png' }] });
});

afterEach(() => {
	closeTestDb();
	resetEndpointGatesForTests();
});

const endpoint = (maxConcurrent = Infinity): LoadedEndpoint => ({
	id: 'bridge',
	displayName: 'Bridge',
	baseUrl: 'http://localhost/v1',
	apiKey: null,
	requestTimeoutSeconds: 120,
	providerQuirk: 'passthrough',
	groupBy: 'endpoint',
	supportsTools: true,
	maxConcurrent,
});

/** Drain an SSE ReadableStream into the parsed event objects. */
async function drain(stream: ReadableStream<Uint8Array>): Promise<StreamEvent[]> {
	const events: StreamEvent[] = [];
	const reader = stream.getReader();
	const dec = new TextDecoder();
	let buf = '';
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		buf += dec.decode(value, { stream: true });
		let idx: number;
		while ((idx = buf.indexOf('\n\n')) !== -1) {
			const line = buf
				.slice(0, idx)
				.split('\n')
				.find((l) => l.startsWith('data: '));
			buf = buf.slice(idx + 2);
			if (line) events.push(JSON.parse(line.slice(6)));
		}
	}
	return events;
}

/** A conversation + its shared user message, the fan-out anchor. */
function seedConvWithUser() {
	const user = seedUser();
	const conv = createConversation({
		userId: user.id,
		endpointId: 'bridge',
		modelId: 'bridge::sdxl',
		modelKind: 'image',
	});
	const userMessage = appendMessage({
		conversationId: conv.id,
		parentMessageId: null,
		role: 'user',
		parts: [{ type: 'text', text: 'a cat' }],
	});
	return { user, conv, userMessage };
}

function baseParams(over: Partial<ImageRelayParams> & Pick<ImageRelayParams, 'userMessage'>) {
	const { userMessage } = over;
	return {
		conversationId: over.conversationId ?? 'c',
		userId: over.userId ?? 'u',
		conversationTitle: 'T',
		endpoint: over.endpoint ?? endpoint(),
		storedModelId: 'bridge::sdxl',
		upstreamModelId: 'sdxl',
		prompt: 'a cat',
		userMessage,
		dispatchMediaIds: over.dispatchMediaIds ?? [],
		sourceMediaId: over.sourceMediaId ?? null,
		abortSignal: over.abortSignal,
		advanceActiveLeaf: over.advanceActiveLeaf,
		suppressTitleTask: over.suppressTitleTask ?? false,
		replacesMessageId: over.replacesMessageId,
		onStarted: over.onStarted,
		onComplete: over.onComplete ?? vi.fn(),
	} satisfies ImageRelayParams;
}

describe('startImageRelay — happy path', () => {
	it('emits start → done, persists the assistant sibling, and fires onStarted/onComplete', async () => {
		const { conv, user, userMessage } = seedConvWithUser();
		const onStarted = vi.fn();
		const onComplete = vi.fn();
		const events = await drain(
			startImageRelay(
				baseParams({
					conversationId: conv.id,
					userId: user.id,
					userMessage: userMessage as ChatMessage,
					onStarted,
					onComplete,
				}),
			),
		);

		const types = events.map((e) => e.type);
		expect(types).toEqual(['start', 'done']); // no queued under unlimited capacity
		expect(onStarted).toHaveBeenCalledOnce();
		expect(onComplete).toHaveBeenCalledOnce();

		const done = events.find((e) => e.type === 'done')!;
		const persistedId = (done as { assistantMessage: ChatMessage }).assistantMessage.id;
		// The assistant image sibling is persisted under the shared user message.
		const sibs = getSiblingAssistants(conv.id, userMessage.id);
		expect(sibs.map((s) => s.id)).toEqual([persistedId]);
		expect(mocks.persistGeneratedImage).toHaveBeenCalledOnce();
		expect(mocks.linkMessageMedia).toHaveBeenCalledWith(persistedId, 'media-out');
	});

	it('routes attached input images through imageEdit (i2i), else imageGeneration (t2i)', async () => {
		const { conv, user, userMessage } = seedConvWithUser();
		mocks.loadMediaBytes.mockResolvedValue({
			bytes: new Uint8Array([1]),
			contentType: 'image/png',
		});
		mocks.imageEdit.mockResolvedValue({ data: [{ url: 'http://img/edit.png' }] });
		await drain(
			startImageRelay(
				baseParams({
					conversationId: conv.id,
					userId: user.id,
					userMessage: userMessage as ChatMessage,
					dispatchMediaIds: ['src-1'],
				}),
			),
		);
		expect(mocks.imageEdit).toHaveBeenCalledOnce();
		expect(mocks.imageGeneration).not.toHaveBeenCalled();
		expect(mocks.loadMediaBytes).toHaveBeenCalledWith('src-1', user.id);
	});
});

describe('startImageRelay — fan-out semantics', () => {
	it('advanceActiveLeaf:false pins the leaf at the shared user message', async () => {
		const { conv, user, userMessage } = seedConvWithUser();
		await drain(
			startImageRelay(
				baseParams({
					conversationId: conv.id,
					userId: user.id,
					userMessage: userMessage as ChatMessage,
					advanceActiveLeaf: false,
				}),
			),
		);
		// Leaf stays pinned (fan-out branches don't ping-pong it); the sibling exists.
		expect(getConversationDetail(conv.id, user.id)!.activeLeafMessageId).toBe(userMessage.id);
		expect(getSiblingAssistants(conv.id, userMessage.id)).toHaveLength(1);
	});

	it('replacesMessageId deletes the old sibling server-side once the re-roll lands', async () => {
		const { conv, user, userMessage } = seedConvWithUser();
		// An existing sibling (the image being re-rolled).
		const old = appendMessage({
			conversationId: conv.id,
			parentMessageId: userMessage.id,
			role: 'assistant',
			parts: [{ type: 'image', mediaId: 'old-media' }],
			modelUsed: 'bridge::sdxl',
			advanceActiveLeaf: false,
		});
		const events = await drain(
			startImageRelay(
				baseParams({
					conversationId: conv.id,
					userId: user.id,
					userMessage: userMessage as ChatMessage,
					advanceActiveLeaf: false,
					replacesMessageId: old.id,
				}),
			),
		);
		const newId = (events.find((e) => e.type === 'done') as { assistantMessage: ChatMessage })
			.assistantMessage.id;
		// Old gone, only the re-roll remains under the parent.
		expect(getMessage(conv.id, old.id)).toBeNull();
		expect(getSiblingAssistants(conv.id, userMessage.id).map((s) => s.id)).toEqual([newId]);
	});

	it('suppressTitleTask omits the per-branch title task (no title event)', async () => {
		const { conv, user, userMessage } = seedConvWithUser();
		const events = await drain(
			startImageRelay(
				baseParams({
					conversationId: conv.id,
					userId: user.id,
					userMessage: userMessage as ChatMessage,
					suppressTitleTask: true,
				}),
			),
		);
		expect(events.some((e) => e.type === 'title')).toBe(false);
	});
});

describe('startImageRelay — backpressure + failure', () => {
	it('emits queued while waiting on a full per-endpoint slot, then proceeds', async () => {
		const { conv, user, userMessage } = seedConvWithUser();
		// Pre-occupy the single slot so the relay must queue.
		const held = await acquireEndpointSlot('bridge', 1, {});
		const stream = startImageRelay(
			baseParams({
				conversationId: conv.id,
				userId: user.id,
				userMessage: userMessage as ChatMessage,
				endpoint: endpoint(1),
			}),
		);
		// Let the relay queue (onQueued fires synchronously at construction), then free it.
		queueMicrotask(() => held.release());
		const events = await drain(stream);
		const types = events.map((e) => e.type);
		expect(types[0]).toBe('queued');
		expect(types).toContain('done');
	});

	it('surfaces an upstream failure as an error event and persists nothing', async () => {
		const { conv, user, userMessage } = seedConvWithUser();
		mocks.imageGeneration.mockRejectedValue(new Error('bridge exploded'));
		const onComplete = vi.fn();
		const events = await drain(
			startImageRelay(
				baseParams({
					conversationId: conv.id,
					userId: user.id,
					userMessage: userMessage as ChatMessage,
					onComplete,
				}),
			),
		);
		const err = events.find((e) => e.type === 'error') as { message: string } | undefined;
		expect(err?.message).toContain('bridge exploded');
		expect(events.some((e) => e.type === 'done')).toBe(false);
		expect(getSiblingAssistants(conv.id, userMessage.id)).toHaveLength(0);
		expect(onComplete).toHaveBeenCalledOnce(); // slot still released
	});

	it('reports a pre-aborted generation as Cancelled (not a failure)', async () => {
		const { conv, user, userMessage } = seedConvWithUser();
		const ctrl = new AbortController();
		ctrl.abort();
		const events = await drain(
			startImageRelay(
				baseParams({
					conversationId: conv.id,
					userId: user.id,
					userMessage: userMessage as ChatMessage,
					abortSignal: ctrl.signal,
				}),
			),
		);
		const err = events.find((e) => e.type === 'error') as { message: string } | undefined;
		expect(err?.message).toBe('Cancelled');
	});
});
