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
	notify: vi.fn(async () => {}),
	getImageEnhancerModel: vi.fn(),
	enhancePrompt: vi.fn(),
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
vi.mock('$lib/server/push/notify', () => ({ notifyConversationComplete: mocks.notify }));
vi.mock('$lib/server/tasks/title-task-runner', () => ({
	startTitleTaskIfFirstExchange: vi.fn(() => Promise.resolve(null)),
	raceTitle: vi.fn(async (p: Promise<string | null>) => p),
}));
vi.mock('$lib/server/tasks/image-enhancer-model', () => ({
	getImageEnhancerModel: mocks.getImageEnhancerModel,
}));
vi.mock('$lib/server/streaming/prompt-enhancer', () => ({
	enhancePrompt: mocks.enhancePrompt,
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
	mocks.notify.mockReset().mockResolvedValue(undefined);
	mocks.imageGeneration.mockResolvedValue({ data: [{ url: 'http://img/out.png' }] });
	// Enhancement off by default — resolves to null so non-enhancement tests are
	// unaffected (the relay's prepare step no-ops without a configured enhancer).
	mocks.getImageEnhancerModel.mockReset().mockReturnValue(null);
	mocks.enhancePrompt.mockReset();
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
	contextWindow: null,
	modelContextWindows: {},
	modelPromptStyles: {},
	modelPromptHints: {},
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
		promptStyle: over.promptStyle,
		promptHint: over.promptHint,
		enhancementEnabled: over.enhancementEnabled,
		abortSignal: over.abortSignal,
		advanceActiveLeaf: over.advanceActiveLeaf,
		suppressTitleTask: over.suppressTitleTask ?? false,
		suppressNotify: over.suppressNotify ?? false,
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
	it('suppressNotify skips the per-branch notification (aggregate handles it)', async () => {
		const { conv, user, userMessage } = seedConvWithUser();
		await drain(
			startImageRelay(
				baseParams({
					conversationId: conv.id,
					userId: user.id,
					userMessage: userMessage as ChatMessage,
					suppressNotify: true,
				}),
			),
		);
		expect(mocks.notify).not.toHaveBeenCalled();
	});

	it('notifies per-branch when suppressNotify is false (plain single send)', async () => {
		const { conv, user, userMessage } = seedConvWithUser();
		await drain(
			startImageRelay(
				baseParams({
					conversationId: conv.id,
					userId: user.id,
					userMessage: userMessage as ChatMessage,
					suppressNotify: false,
				}),
			),
		);
		expect(mocks.notify).toHaveBeenCalledOnce();
	});

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

	it('an additive re-roll adds a sibling without touching the original', async () => {
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
		// Let the relay reach its slot-wait (past the pre-slot prepare step's async
		// hops) and emit `queued`, THEN free it. A macrotask, not queueMicrotask —
		// the relay takes a few microtasks to get there, so releasing on a
		// microtask could win the race and free the slot before it's contended.
		setTimeout(() => held.release(), 0);
		const events = await drain(stream);
		const types = events.map((e) => e.type);
		expect(types[0]).toBe('queued');
		expect(types).toContain('done');
	});

	it('surfaces an upstream failure as an error event AND persists a durable error sibling', async () => {
		const { conv, user, userMessage } = seedConvWithUser();
		mocks.imageGeneration.mockRejectedValue(new Error('bridge exploded'));
		const onComplete = vi.fn();
		const events = await drain(
			startImageRelay(
				baseParams({
					conversationId: conv.id,
					userId: user.id,
					userMessage: userMessage as ChatMessage,
					advanceActiveLeaf: false,
					onComplete,
				}),
			),
		);
		const err = events.find((e) => e.type === 'error') as { message: string } | undefined;
		expect(err?.message).toContain('bridge exploded');
		expect(events.some((e) => e.type === 'done')).toBe(false);
		// The failure is now durably recorded as an error sibling so a recovered
		// fan-out can show it instead of silently dropping the column.
		const sibs = getSiblingAssistants(conv.id, userMessage.id);
		expect(sibs).toHaveLength(1);
		expect(sibs[0].parts[0]).toMatchObject({ type: 'error' });
		expect((sibs[0].parts[0] as { type: 'error'; message: string }).message).toContain(
			'bridge exploded',
		);
		expect(onComplete).toHaveBeenCalledOnce(); // slot still released
	});

	it('reports a pre-aborted generation as Cancelled (not a failure) and persists nothing', async () => {
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
					advanceActiveLeaf: false,
				}),
			),
		);
		const err = events.find((e) => e.type === 'error') as { message: string } | undefined;
		expect(err?.message).toBe('Cancelled');
		// Cancellation bails quietly — no durable error record (unlike a failure).
		expect(getSiblingAssistants(conv.id, userMessage.id)).toHaveLength(0);
	});
});

describe('startImageRelay — prompt enhancement', () => {
	// The enhancer lives on its OWN endpoint (separate from the image 'bridge'),
	// so its slot is independent — the parallel case.
	const enhancerEndpoint = (): LoadedEndpoint => ({ ...endpoint(), id: 'enhancer' });
	function enableEnhancer(maxConcurrent = Infinity) {
		mocks.getImageEnhancerModel.mockReturnValue({
			endpoint: { ...enhancerEndpoint(), maxConcurrent },
			upstreamId: 'qwen',
			maxTokens: 200,
			temperature: 0.7,
			styleInstructionOverrides: {},
		});
	}

	it('enhances in the pre-slot phase: generates with the enhanced prompt + records the original', async () => {
		const { conv, user, userMessage } = seedConvWithUser();
		enableEnhancer();
		mocks.enhancePrompt.mockResolvedValue({ enhanced: '1cat, fluffy, sleeping', changed: true });
		const events = await drain(
			startImageRelay(
				baseParams({
					conversationId: conv.id,
					userId: user.id,
					userMessage: userMessage as ChatMessage,
					promptStyle: 'booru-tags',
					enhancementEnabled: true,
				}),
			),
		);
		// Emitted the transient "Enhancing prompt…" status.
		expect(
			events.some(
				(e) => e.type === 'progress' && (e as { status?: string }).status === 'Enhancing prompt…',
			),
		).toBe(true);
		// Generated with the ENHANCED prompt, and recorded the user's original.
		expect(mocks.imageGeneration.mock.calls[0][1]).toMatchObject({
			prompt: '1cat, fluffy, sleeping',
		});
		expect(mocks.persistGeneratedImage).toHaveBeenCalledWith(
			expect.objectContaining({ prompt: '1cat, fluffy, sleeping', originalPrompt: 'a cat' }),
		);
	});

	it('does NOT hold the image endpoint slot during enhancement', async () => {
		const { conv, user, userMessage } = seedConvWithUser();
		enableEnhancer();
		// Block enhancement until we release it, to observe ordering against the slot.
		let releaseEnhance!: () => void;
		mocks.enhancePrompt.mockImplementation(
			() =>
				new Promise((res) => {
					releaseEnhance = () => res({ enhanced: 'enhanced cat', changed: true });
				}),
		);
		// Occupy the single IMAGE slot ('bridge').
		const held = await acquireEndpointSlot('bridge', 1, {});
		const drained = drain(
			startImageRelay(
				baseParams({
					conversationId: conv.id,
					userId: user.id,
					userMessage: userMessage as ChatMessage,
					endpoint: endpoint(1),
					promptStyle: 'natural-language',
					enhancementEnabled: true,
				}),
			),
		);
		// Enhancement runs even though the image slot is held → it is NOT gated by it.
		await vi.waitFor(() => expect(mocks.enhancePrompt).toHaveBeenCalled());
		expect(mocks.imageGeneration).not.toHaveBeenCalled();
		// Finish enhancing; generation still blocks on the held image slot.
		releaseEnhance();
		await Promise.resolve();
		expect(mocks.imageGeneration).not.toHaveBeenCalled();
		// Free the image slot → generation proceeds with the enhanced prompt.
		held.release();
		await drained;
		expect(mocks.imageGeneration.mock.calls[0][1]).toMatchObject({ prompt: 'enhanced cat' });
	});

	it('cancels the whole generation when enhancement is aborted (Stop mid-enhance)', async () => {
		const { conv, user, userMessage } = seedConvWithUser();
		enableEnhancer();
		const onComplete = vi.fn();
		// The user hit Stop during the enhancement call: enhancePrompt propagates
		// the abort (it no longer swallows it), so the relay's pre-slot prepare
		// step must cancel — not fall through to generation.
		mocks.enhancePrompt.mockRejectedValue(new DOMException('aborted', 'AbortError'));
		const events = await drain(
			startImageRelay(
				baseParams({
					conversationId: conv.id,
					userId: user.id,
					userMessage: userMessage as ChatMessage,
					promptStyle: 'natural-language',
					enhancementEnabled: true,
					onComplete,
				}),
			),
		);
		const err = events.find((e) => e.type === 'error') as { message: string } | undefined;
		expect(err?.message).toBe('Cancelled');
		expect(mocks.imageGeneration).not.toHaveBeenCalled();
		expect(events.some((e) => e.type === 'done')).toBe(false);
		// Cancellation bails quietly — no durable sibling — but the slot/in-flight
		// is still released via onComplete.
		expect(getSiblingAssistants(conv.id, userMessage.id)).toHaveLength(0);
		expect(onComplete).toHaveBeenCalledOnce();
	});

	it('serializes when the enhancer shares the image endpoint at max_concurrent=1', async () => {
		const { conv, user, userMessage } = seedConvWithUser();
		// Enhancer on the SAME endpoint as the image model ('bridge'), cap 1.
		mocks.getImageEnhancerModel.mockReturnValue({
			endpoint: endpoint(1), // id 'bridge', maxConcurrent 1
			upstreamId: 'qwen',
			maxTokens: 200,
			temperature: 0.7,
			styleInstructionOverrides: {},
		});
		mocks.enhancePrompt.mockResolvedValue({ enhanced: 'enhanced cat', changed: true });
		// Hold the single shared slot; the relay must wait for it before it can
		// even enhance (enhancement + generation share the one slot → serial).
		const held = await acquireEndpointSlot('bridge', 1, {});
		const drained = drain(
			startImageRelay(
				baseParams({
					conversationId: conv.id,
					userId: user.id,
					userMessage: userMessage as ChatMessage,
					endpoint: endpoint(1),
					promptStyle: 'natural-language',
					enhancementEnabled: true,
				}),
			),
		);
		await Promise.resolve();
		await Promise.resolve();
		// Shared slot is held → enhancement can't even start.
		expect(mocks.enhancePrompt).not.toHaveBeenCalled();
		held.release();
		await drained;
		expect(mocks.enhancePrompt).toHaveBeenCalled();
		expect(mocks.imageGeneration.mock.calls[0][1]).toMatchObject({ prompt: 'enhanced cat' });
	});
});
