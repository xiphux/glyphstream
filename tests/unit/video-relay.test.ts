/**
 * Unit tests for the async video relay. The poll loop only sleeps while the job
 * is still running, so a job that comes back `completed` from videoCreate skips
 * polling entirely — letting us assert the start→progress→done sequence, the
 * onJobId / onStarted callbacks, fan-out leaf pinning, the regenerate delete,
 * and the failed/cancelled paths without fake timers.
 *
 * Modeled on relay-tool-loop.test.ts: real test DB + gate, mocked side-effects.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({
	testDb: null as unknown as TestDB,
	videoCreate: vi.fn(),
	videoStatus: vi.fn(),
	videoFetchContent: vi.fn(),
	videoCancel: vi.fn(async () => {}),
	persistGeneratedVideo: vi.fn(),
	linkMessageMedia: vi.fn(),
	unlinkMediaFiles: vi.fn(async () => {}),
}));

vi.mock('$lib/server/db/client', () => ({ getDb: () => mocks.testDb, closeDb: () => {} }));
vi.mock('$lib/server/endpoints/client', async (orig) => ({
	...(await orig<typeof import('$lib/server/endpoints/client')>()),
	videoCreate: mocks.videoCreate,
	videoStatus: mocks.videoStatus,
	videoFetchContent: mocks.videoFetchContent,
	videoCancel: mocks.videoCancel,
}));
vi.mock('$lib/server/media/persister', () => ({
	persistGeneratedVideo: mocks.persistGeneratedVideo,
}));
vi.mock('$lib/server/db/queries/media', async (orig) => ({
	...(await orig<typeof import('$lib/server/db/queries/media')>()),
	linkMessageMedia: mocks.linkMessageMedia,
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
import { startVideoRelay, type VideoRelayParams } from '$lib/server/streaming/video-relay';
import { acquireEndpointSlot, resetEndpointGatesForTests } from '$lib/server/endpoints/concurrency';
import type { LoadedEndpoint } from '$lib/server/endpoints/config';
import type { ChatMessage, StreamEvent } from '$lib/types/api';

beforeEach(() => {
	mocks.testDb = createTestDb();
	mocks.videoCreate
		.mockReset()
		.mockResolvedValue({ id: 'job-1', status: 'completed', progress: 100 });
	mocks.videoStatus.mockReset();
	mocks.videoFetchContent
		.mockReset()
		.mockResolvedValue({ bytes: Buffer.from([0, 1, 2]), contentType: 'video/mp4' });
	mocks.videoCancel.mockReset().mockResolvedValue(undefined);
	mocks.persistGeneratedVideo.mockReset().mockResolvedValue('media-vid');
	mocks.linkMessageMedia.mockReset();
	mocks.unlinkMediaFiles.mockReset().mockResolvedValue(undefined);
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

function seedConvWithUser() {
	const user = seedUser();
	const conv = createConversation({
		userId: user.id,
		endpointId: 'bridge',
		modelId: 'bridge::sora',
		modelKind: 'video',
	});
	const userMessage = appendMessage({
		conversationId: conv.id,
		parentMessageId: null,
		role: 'user',
		parts: [{ type: 'text', text: 'a dog running' }],
	});
	return { user, conv, userMessage };
}

function baseParams(over: Partial<VideoRelayParams> & Pick<VideoRelayParams, 'userMessage'>) {
	return {
		conversationId: over.conversationId ?? 'c',
		userId: over.userId ?? 'u',
		conversationTitle: 'T',
		endpoint: over.endpoint ?? endpoint(),
		storedModelId: 'bridge::sora',
		prompt: 'a dog running',
		userMessage: over.userMessage,
		sourceMediaId: over.sourceMediaId ?? null,
		abortSignal: over.abortSignal,
		advanceActiveLeaf: over.advanceActiveLeaf,
		suppressTitleTask: over.suppressTitleTask ?? false,
		onStarted: over.onStarted,
		onJobId: over.onJobId,
		onComplete: over.onComplete ?? vi.fn(),
	} satisfies VideoRelayParams;
}

describe('startVideoRelay — happy path', () => {
	it('emits start → progress → done, persists the sibling, fires onStarted/onJobId/onComplete', async () => {
		const { conv, user, userMessage } = seedConvWithUser();
		const onStarted = vi.fn();
		const onJobId = vi.fn();
		const onComplete = vi.fn();
		const events = await drain(
			startVideoRelay(
				baseParams({
					conversationId: conv.id,
					userId: user.id,
					userMessage: userMessage as ChatMessage,
					onStarted,
					onJobId,
					onComplete,
				}),
			),
		);

		const types = events.map((e) => e.type);
		expect(types[0]).toBe('start');
		expect(types).toContain('progress');
		expect(types).toContain('done');
		expect(onStarted).toHaveBeenCalledOnce();
		expect(onJobId).toHaveBeenCalledWith('job-1');
		expect(onComplete).toHaveBeenCalledOnce();

		const newId = (events.find((e) => e.type === 'done') as { assistantMessage: ChatMessage })
			.assistantMessage.id;
		expect(getSiblingAssistants(conv.id, userMessage.id).map((s) => s.id)).toEqual([newId]);
		expect(mocks.linkMessageMedia).toHaveBeenCalledWith(newId, 'media-vid');
	});
});

describe('startVideoRelay — fan-out semantics', () => {
	it('advanceActiveLeaf:false pins the leaf at the shared user message', async () => {
		const { conv, user, userMessage } = seedConvWithUser();
		await drain(
			startVideoRelay(
				baseParams({
					conversationId: conv.id,
					userId: user.id,
					userMessage: userMessage as ChatMessage,
					advanceActiveLeaf: false,
				}),
			),
		);
		expect(getConversationDetail(conv.id, user.id)!.activeLeafMessageId).toBe(userMessage.id);
		expect(getSiblingAssistants(conv.id, userMessage.id)).toHaveLength(1);
	});

	it('an additive re-roll adds a sibling without touching the original', async () => {
		const { conv, user, userMessage } = seedConvWithUser();
		const old = appendMessage({
			conversationId: conv.id,
			parentMessageId: userMessage.id,
			role: 'assistant',
			parts: [{ type: 'video', mediaId: 'old-vid' }],
			modelUsed: 'bridge::sora',
			advanceActiveLeaf: false,
		});
		const events = await drain(
			startVideoRelay(
				baseParams({
					conversationId: conv.id,
					userId: user.id,
					userMessage: userMessage as ChatMessage,
					advanceActiveLeaf: false,
				}),
			),
		);
		const newId = (events.find((e) => e.type === 'done') as { assistantMessage: ChatMessage })
			.assistantMessage.id;
		// Non-destructive: the original survives, the re-roll lands beside it.
		expect(getMessage(conv.id, old.id)).not.toBeNull();
		const ids = getSiblingAssistants(conv.id, userMessage.id).map((s) => s.id);
		expect(ids).toHaveLength(2);
		expect(ids).toEqual(expect.arrayContaining([old.id, newId]));
	});
});

describe('startVideoRelay — backpressure + failure', () => {
	it('emits queued while waiting on a full per-endpoint slot, then proceeds', async () => {
		const { conv, user, userMessage } = seedConvWithUser();
		const held = await acquireEndpointSlot('bridge', 1, {});
		const stream = startVideoRelay(
			baseParams({
				conversationId: conv.id,
				userId: user.id,
				userMessage: userMessage as ChatMessage,
				endpoint: endpoint(1),
			}),
		);
		queueMicrotask(() => held.release());
		const events = await drain(stream);
		expect(events.map((e) => e.type)[0]).toBe('queued');
		expect(events.some((e) => e.type === 'done')).toBe(true);
	});

	it('surfaces a failed job as an error and persists nothing', async () => {
		const { conv, user, userMessage } = seedConvWithUser();
		mocks.videoCreate.mockResolvedValue({
			id: 'job-x',
			status: 'failed',
			error: { message: 'render crashed' },
		});
		const events = await drain(
			startVideoRelay(
				baseParams({
					conversationId: conv.id,
					userId: user.id,
					userMessage: userMessage as ChatMessage,
				}),
			),
		);
		const err = events.find((e) => e.type === 'error') as { message: string } | undefined;
		expect(err?.message).toBe('render crashed');
		expect(getSiblingAssistants(conv.id, userMessage.id)).toHaveLength(0);
	});

	it('reports a pre-aborted job as Cancelled (no slot consumed past release)', async () => {
		const { conv, user, userMessage } = seedConvWithUser();
		const ctrl = new AbortController();
		ctrl.abort();
		const events = await drain(
			startVideoRelay(
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
