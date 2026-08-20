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
import { Readable } from 'node:stream';
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
	getImageEnhancerModel: vi.fn(() => null as unknown),
	enhancePrompt: vi.fn(),
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
vi.mock('$lib/server/tasks/image-enhancer-model', () => ({
	getImageEnhancerModel: mocks.getImageEnhancerModel,
}));
vi.mock('$lib/server/streaming/prompt-enhancer', () => ({
	enhancePrompt: mocks.enhancePrompt,
}));
vi.mock('$lib/server/push/notify', () => ({ notifyConversationComplete: vi.fn(async () => {}) }));
vi.mock('$lib/server/tasks/title-task-runner', () => ({
	startTitleTaskIfFirstExchange: vi.fn(() => Promise.resolve(null)),
	raceTitle: vi.fn(async (p: Promise<string | null>) => p),
}));

import { createConversation, getConversationDetail } from '$lib/server/db/queries/conversations';
import { appendMessage, getMessage, getSiblingAssistants } from '$lib/server/db/queries/messages';
import { startVideoRelay, type VideoRelayParams } from '$lib/server/streaming/video-relay';
import { UpstreamError } from '$lib/server/endpoints/client';
import { startTitleTaskIfFirstExchange } from '$lib/server/tasks/title-task-runner';
import {
	acquireEndpointSlot,
	getResourceQueueDepth,
	resetEndpointGatesForTests,
} from '$lib/server/endpoints/concurrency';
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
		.mockResolvedValue({ stream: Readable.from(Buffer.from([0, 1, 2])), contentType: 'video/mp4' });
	mocks.videoCancel.mockReset().mockResolvedValue(undefined);
	mocks.persistGeneratedVideo.mockReset().mockResolvedValue('media-vid');
	mocks.linkMessageMedia.mockReset();
	mocks.unlinkMediaFiles.mockReset().mockResolvedValue(undefined);
	// Enhancement off by default — no configured enhancer, so the prepare step
	// no-ops and non-enhancement tests are unaffected.
	mocks.getImageEnhancerModel.mockReset().mockReturnValue(null);
	mocks.enhancePrompt.mockReset();
});

afterEach(() => {
	closeTestDb();
	resetEndpointGatesForTests();
});

const endpoint = (maxConcurrent = Infinity): LoadedEndpoint => ({
	id: 'bridge',
	// A lone endpoint is its own group — what config.ts resolves when
	// `resource_group` is absent.
	resourceGroup: 'bridge',
	resourceGroupMaxConcurrent: maxConcurrent,
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
			if (line) events.push(JSON.parse(line.slice(6)) as StreamEvent);
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
		inputReference: over.inputReference,
		sourceMediaId: over.sourceMediaId ?? null,
		promptStyle: over.promptStyle,
		promptHint: over.promptHint,
		enhancementEnabled: over.enhancementEnabled,
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

describe('startVideoRelay — progress status is display text', () => {
	// Regression: the poll loop forwarded `job.status` verbatim, so a `progress`
	// event carried the provider enum. The fan-out grid renders that label in
	// place of "Generating…", which surfaced a literal "in_progress 24.8s" while
	// a video generated. The status field is display text; the enum stays server-side.
	const PROVIDER_ENUM = ['queued', 'in_progress', 'completed', 'failed'];

	function progressStatuses(events: StreamEvent[]): Array<string | undefined> {
		return events
			.filter((e) => e.type === 'progress')
			.map((e) => (e as { status?: string }).status);
	}

	// `createStatus` is deliberately `unknown`: VideoStatus is a compile-time
	// assumption (the poll response is cast, not validated), so these cases feed
	// the relay what a misbehaving bridge could actually put on the wire.
	async function drainPolledJob(createStatus: unknown): Promise<StreamEvent[]> {
		vi.useFakeTimers();
		try {
			const { conv, user, userMessage } = seedConvWithUser();
			mocks.videoCreate
				.mockReset()
				.mockResolvedValue({ id: 'job-p', status: createStatus, progress: 10 });
			mocks.videoStatus
				.mockReset()
				.mockResolvedValue({ id: 'job-p', status: 'completed', progress: 100 });
			const drainPromise = drain(
				startVideoRelay(
					baseParams({
						conversationId: conv.id,
						userId: user.id,
						userMessage: userMessage as ChatMessage,
					}),
				),
			);
			await vi.advanceTimersByTimeAsync(10_000);
			return await drainPromise;
		} finally {
			vi.useRealTimers();
		}
	}

	it('omits the status while generating — the views already narrate that themselves', async () => {
		const events = await drainPolledJob('in_progress');
		const statuses = progressStatuses(events);
		expect(statuses.length).toBeGreaterThan(0);
		expect(statuses.every((s) => s === undefined)).toBe(true);
		// The percent still rides along — only the label is suppressed.
		expect(
			events.some((e) => e.type === 'progress' && (e as { percent: number | null }).percent === 10),
		).toBe(true);
	});

	it('maps an upstream-queued job to a readable label', async () => {
		const statuses = progressStatuses(await drainPolledJob('queued'));
		expect(statuses).toContain('Queued upstream…');
		expect(statuses.some((s) => s !== undefined && PROVIDER_ENUM.includes(s))).toBe(false);
	});

	// The enum is a compile-time assumption — the poll response is parsed, not
	// validated. A bridge reporting a fourth state must not vanish behind a bare
	// ticking timer: the loop only exits on completed/failed, so an unlabelled
	// unknown status would spin to MAX_WAIT_MS looking identical to generating.
	it('surfaces an unrecognized upstream status instead of swallowing it', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const statuses = progressStatuses(await drainPolledJob('stalled_on_runner'));
			expect(statuses).toContain('stalled_on_runner');
			expect(warn).toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it('truncates an unrecognized status so it cannot wreck the badge layout', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const statuses = progressStatuses(await drainPolledJob('x'.repeat(500)));
			const surfaced = statuses.find((s) => s !== undefined);
			expect(surfaced).toBe('x'.repeat(32));
			// The log is truncated too, not just the on-screen label.
			expect(warn.mock.calls.flat().join(' ')).not.toContain('x'.repeat(33));
		} finally {
			warn.mockRestore();
		}
	});

	// A bridge that omits `status` entirely used to coerce to the literal string
	// "undefined" and render it as the label — the same leak as `in_progress`,
	// one layer down.
	it.each([
		['omitted', undefined],
		['null', null],
		['empty', ''],
	])('emits no label when the upstream status is %s', async (_name, value) => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const statuses = progressStatuses(await drainPolledJob(value));
			expect(statuses.length).toBeGreaterThan(0);
			expect(statuses.every((s) => s === undefined)).toBe(true);
		} finally {
			warn.mockRestore();
		}
	});

	// The label lookup must not resolve inherited members for a provider-supplied
	// key — `toString` would have returned a function (silently swallowed) and
	// `__proto__` an object (rendering "[object Object]").
	it.each(['toString', '__proto__', 'constructor'])(
		'treats the prototype key %s as an ordinary unrecognized status',
		async (value) => {
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			try {
				const statuses = progressStatuses(await drainPolledJob(value));
				expect(statuses).toContain(value);
			} finally {
				warn.mockRestore();
			}
		},
	);
});

describe('startVideoRelay — prompt enhancement', () => {
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

	it('enhances a T2V send: generates with the enhanced prompt + records the original', async () => {
		const { conv, user, userMessage } = seedConvWithUser();
		enableEnhancer();
		mocks.enhancePrompt.mockResolvedValue({
			enhanced: 'A dog runs across a field as the camera tracks alongside, warm dusk light.',
			changed: true,
		});
		const events = await drain(
			startVideoRelay(
				baseParams({
					conversationId: conv.id,
					userId: user.id,
					userMessage: userMessage as ChatMessage,
					promptStyle: 'cinematic-prose',
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
		// enhancePrompt was asked to rewrite for the VIDEO medium.
		expect(mocks.enhancePrompt.mock.calls[0][0]).toMatchObject({ medium: 'video' });
		// Created the job with the ENHANCED prompt, and recorded the user's original.
		expect(mocks.videoCreate.mock.calls[0][1]).toMatchObject({
			prompt: 'A dog runs across a field as the camera tracks alongside, warm dusk light.',
		});
		expect(mocks.persistGeneratedVideo).toHaveBeenCalledWith(
			expect.objectContaining({
				prompt: 'A dog runs across a field as the camera tracks alongside, warm dusk light.',
				originalPrompt: 'a dog running',
			}),
		);
	});

	it('skips enhancement for an I2V send (reference frame present)', async () => {
		const { conv, user, userMessage } = seedConvWithUser();
		enableEnhancer();
		mocks.enhancePrompt.mockResolvedValue({ enhanced: 'nope', changed: true });
		await drain(
			startVideoRelay(
				baseParams({
					conversationId: conv.id,
					userId: user.id,
					userMessage: userMessage as ChatMessage,
					inputReference: { bytes: Buffer.from([9]), contentType: 'image/png' },
					promptStyle: 'cinematic-prose',
					enhancementEnabled: true,
				}),
			),
		);
		expect(mocks.enhancePrompt).not.toHaveBeenCalled();
		expect(mocks.videoCreate.mock.calls[0][1]).toMatchObject({ prompt: 'a dog running' });
	});

	it('does not enhance when the feature is toggled off', async () => {
		const { conv, user, userMessage } = seedConvWithUser();
		enableEnhancer();
		await drain(
			startVideoRelay(
				baseParams({
					conversationId: conv.id,
					userId: user.id,
					userMessage: userMessage as ChatMessage,
					promptStyle: 'cinematic-prose',
					enhancementEnabled: false,
				}),
			),
		);
		expect(mocks.enhancePrompt).not.toHaveBeenCalled();
	});

	it('does not enhance when no enhancer model is configured', async () => {
		const { conv, user, userMessage } = seedConvWithUser();
		// getImageEnhancerModel stays null (default) → prepare no-ops.
		await drain(
			startVideoRelay(
				baseParams({
					conversationId: conv.id,
					userId: user.id,
					userMessage: userMessage as ChatMessage,
					promptStyle: 'cinematic-prose',
					enhancementEnabled: true,
				}),
			),
		);
		expect(mocks.enhancePrompt).not.toHaveBeenCalled();
	});

	it('does NOT hold the video endpoint slot during enhancement', async () => {
		const { conv, user, userMessage } = seedConvWithUser();
		enableEnhancer(); // enhancer on its OWN endpoint ('enhancer'), independent slot
		// Block enhancement until we release it, to observe ordering against the slot.
		let releaseEnhance!: () => void;
		mocks.enhancePrompt.mockImplementation(
			() =>
				new Promise((res) => {
					releaseEnhance = () => res({ enhanced: 'enhanced dog', changed: true });
				}),
		);
		// Occupy the single VIDEO slot ('bridge').
		const held = await acquireEndpointSlot(endpoint(1));
		const drained = drain(
			startVideoRelay(
				baseParams({
					conversationId: conv.id,
					userId: user.id,
					userMessage: userMessage as ChatMessage,
					endpoint: endpoint(1),
					promptStyle: 'cinematic-prose',
					enhancementEnabled: true,
				}),
			),
		);
		// Enhancement runs even though the video slot is held → NOT gated by it.
		await vi.waitFor(() => expect(mocks.enhancePrompt).toHaveBeenCalled());
		expect(mocks.videoCreate).not.toHaveBeenCalled();
		// Finish enhancing; job creation still blocks on the held video slot.
		releaseEnhance();
		await Promise.resolve();
		expect(mocks.videoCreate).not.toHaveBeenCalled();
		// Free the video slot → job creation proceeds with the enhanced prompt.
		held.release();
		await drained;
		expect(mocks.videoCreate.mock.calls[0][1]).toMatchObject({ prompt: 'enhanced dog' });
	});

	it('cancels the whole generation when enhancement is aborted (Stop mid-enhance)', async () => {
		const { conv, user, userMessage } = seedConvWithUser();
		enableEnhancer();
		const onComplete = vi.fn();
		// Stop during enhancement: enhancePrompt propagates the abort, so the
		// relay's pre-slot prepare must cancel — not fall through to job creation.
		mocks.enhancePrompt.mockRejectedValue(new DOMException('aborted', 'AbortError'));
		const events = await drain(
			startVideoRelay(
				baseParams({
					conversationId: conv.id,
					userId: user.id,
					userMessage: userMessage as ChatMessage,
					promptStyle: 'cinematic-prose',
					enhancementEnabled: true,
					onComplete,
				}),
			),
		);
		const err = events.find((e) => e.type === 'error') as { message: string } | undefined;
		expect(err?.message).toBe('Cancelled');
		expect(mocks.videoCreate).not.toHaveBeenCalled();
		expect(events.some((e) => e.type === 'done')).toBe(false);
		// Cancellation bails quietly — no durable sibling — but the slot/in-flight
		// is still released via onComplete.
		expect(getSiblingAssistants(conv.id, userMessage.id)).toHaveLength(0);
		expect(onComplete).toHaveBeenCalledOnce();
	});

	it('serializes when the enhancer shares the video endpoint at max_concurrent=1', async () => {
		const { conv, user, userMessage } = seedConvWithUser();
		// Enhancer on the SAME endpoint as the video model ('bridge'), cap 1.
		mocks.getImageEnhancerModel.mockReturnValue({
			endpoint: endpoint(1), // id 'bridge', maxConcurrent 1
			upstreamId: 'qwen',
			maxTokens: 200,
			temperature: 0.7,
			styleInstructionOverrides: {},
		});
		mocks.enhancePrompt.mockResolvedValue({ enhanced: 'enhanced dog', changed: true });
		// Hold the single shared slot; the relay must wait for it before it can
		// even enhance (enhancement + generation share the one slot → serial).
		const held = await acquireEndpointSlot(endpoint(1));
		const drained = drain(
			startVideoRelay(
				baseParams({
					conversationId: conv.id,
					userId: user.id,
					userMessage: userMessage as ChatMessage,
					endpoint: endpoint(1),
					promptStyle: 'cinematic-prose',
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
		expect(mocks.videoCreate.mock.calls[0][1]).toMatchObject({ prompt: 'enhanced dog' });
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
	it('frees the endpoint slot before the post-done title race', async () => {
		const { conv, user, userMessage } = seedConvWithUser();
		// Title task stays pending; the mocked raceTitle awaits it, so the relay
		// parks on the title race after `done` — the window where the slot must
		// already be free (the title task is gated on the same endpoint slot).
		let resolveTitle!: (t: string | null) => void;
		vi.mocked(startTitleTaskIfFirstExchange).mockReturnValueOnce(
			new Promise<string | null>((r) => (resolveTitle = r)),
		);
		const stream = startVideoRelay(
			baseParams({
				conversationId: conv.id,
				userId: user.id,
				userMessage: userMessage as ChatMessage,
				endpoint: endpoint(1),
			}),
		);
		const reader = stream.getReader();
		const dec = new TextDecoder();
		let buf = '';
		let sawDone = false;
		while (!sawDone) {
			const { value, done } = await reader.read();
			if (done) break;
			buf += dec.decode(value, { stream: true });
			if (buf.includes('"type":"done"')) sawDone = true;
		}
		expect(sawDone).toBe(true);
		// Slot released even though the title race is still pending.
		expect(getResourceQueueDepth('bridge').active).toBe(0);
		resolveTitle('A title');
		for (;;) {
			const { done } = await reader.read();
			if (done) break;
		}
	});

	it('emits queued while waiting on a full per-endpoint slot, then proceeds', async () => {
		const { conv, user, userMessage } = seedConvWithUser();
		const held = await acquireEndpointSlot(endpoint(1));
		const stream = startVideoRelay(
			baseParams({
				conversationId: conv.id,
				userId: user.id,
				userMessage: userMessage as ChatMessage,
				endpoint: endpoint(1),
			}),
		);
		// Release on a macrotask so the relay reaches its slot-wait (past the
		// pre-slot prepare step's async hops) and emits `queued` before the slot
		// frees — a microtask release could win the race and skip the queued state.
		setTimeout(() => held.release(), 0);
		const events = await drain(stream);
		expect(events.map((e) => e.type)[0]).toBe('queued');
		expect(events.some((e) => e.type === 'done')).toBe(true);
	});

	it('surfaces a failed job as an error AND persists a durable error sibling', async () => {
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
					// Fan-out semantics: the failed branch persists as a pinned sibling
					// so a grid recovered after a disconnect can show the failed column.
					advanceActiveLeaf: false,
				}),
			),
		);
		// ...and a durable error sibling now records the failure for recovery.
		const siblings = getSiblingAssistants(conv.id, userMessage.id);
		expect(siblings).toHaveLength(1);
		expect(siblings[0].parts).toEqual([
			{ type: 'error', message: 'render crashed', sourceMediaId: null },
		]);
		// The live error frame still goes out — emitted AFTER the insert, carrying
		// the sibling's id so the fan-out grid's discard can delete the row rather
		// than only hiding the column.
		const err = events.find((e) => e.type === 'error') as
			{ message: string; messageId?: string } | undefined;
		expect(err?.message).toBe('render crashed');
		expect(err?.messageId).toBe(siblings[0].id);
		expect(siblings[0].modelUsed).toBe('bridge::sora');
		// The failed branch produced no media, so nothing is linked.
		expect(mocks.linkMessageMedia).not.toHaveBeenCalled();
		// And it leaves the parked leaf pinned at the shared user message.
		expect(getConversationDetail(conv.id, user.id)!.activeLeafMessageId).toBe(userMessage.id);
	});

	it('a user-cancelled (Stop) job persists nothing — no error sibling', async () => {
		const { conv, user, userMessage } = seedConvWithUser();
		const ctrl = new AbortController();
		ctrl.abort();
		await drain(
			startVideoRelay(
				baseParams({
					conversationId: conv.id,
					userId: user.id,
					userMessage: userMessage as ChatMessage,
					abortSignal: ctrl.signal,
					advanceActiveLeaf: false,
				}),
			),
		);
		// Cancellation is a quiet bail: no durable record, unlike a genuine failure.
		expect(getSiblingAssistants(conv.id, userMessage.id)).toHaveLength(0);
	});

	it('treats a Stop during content fetch as Cancelled — no spurious error sibling', async () => {
		const { conv, user, userMessage } = seedConvWithUser();
		const ctrl = new AbortController();
		// Job completes immediately, but the content fetch fails while the user has
		// already clicked Stop → cancellation, not a durable failure.
		mocks.videoFetchContent.mockImplementation(async () => {
			ctrl.abort();
			throw new Error('aborted');
		});
		const events = await drain(
			startVideoRelay(
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

	it('bails fast on a permanent poll error (job gone) instead of polling to MAX_WAIT_MS', async () => {
		vi.useFakeTimers();
		try {
			const { conv, user, userMessage } = seedConvWithUser();
			const onComplete = vi.fn();
			mocks.videoCreate.mockReset().mockResolvedValue({
				id: 'job-gone',
				status: 'running',
				progress: null,
			});
			// The bridge restarted and lost the job → 404 on every poll. This is a
			// permanent, request-specific failure: bail immediately.
			mocks.videoStatus
				.mockReset()
				.mockRejectedValue(new UpstreamError('no such video job', 404, null));

			const relay = startVideoRelay(
				baseParams({
					conversationId: conv.id,
					userId: user.id,
					userMessage: userMessage as ChatMessage,
					onComplete,
				}),
			);
			const drainPromise = drain(relay);
			// One poll interval is enough to reach the first (failing) status call.
			await vi.advanceTimersByTimeAsync(2_000);
			const events = await drainPromise;

			// Polled exactly once, then gave up — did NOT grind on to 20 minutes.
			expect(mocks.videoStatus).toHaveBeenCalledTimes(1);
			expect(mocks.videoCancel).toHaveBeenCalledWith(endpoint(), 'job-gone');
			const err = events.find((e) => e.type === 'error') as { message: string } | undefined;
			expect(err?.message).toMatch(/failed/i);
			expect(events.some((e) => e.type === 'done')).toBe(false);
			expect(onComplete).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});

	it('keeps polling through a transient poll error until the job completes', async () => {
		vi.useFakeTimers();
		try {
			const { conv, user, userMessage } = seedConvWithUser();
			mocks.videoCreate.mockReset().mockResolvedValue({
				id: 'job-blip',
				status: 'running',
				progress: null,
			});
			// A 503 (transient) on the first poll, then success — must NOT bail.
			mocks.videoStatus
				.mockReset()
				.mockRejectedValueOnce(new UpstreamError('upstream busy', 503, null))
				.mockResolvedValue({ id: 'job-blip', status: 'completed', progress: 100 });

			const relay = startVideoRelay(
				baseParams({
					conversationId: conv.id,
					userId: user.id,
					userMessage: userMessage as ChatMessage,
				}),
			);
			const drainPromise = drain(relay);
			await vi.advanceTimersByTimeAsync(10_000);
			const events = await drainPromise;

			expect(mocks.videoStatus.mock.calls.length).toBeGreaterThanOrEqual(2);
			expect(events.some((e) => e.type === 'done')).toBe(true);
			expect(mocks.videoCancel).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it('calls videoCancel when the polling budget expires (MAX_WAIT_MS)', async () => {
		vi.useFakeTimers();
		try {
			const { conv, user, userMessage } = seedConvWithUser();
			const onComplete = vi.fn();

			// Job never completes — poll loop runs until timeout
			mocks.videoCreate.mockReset().mockResolvedValue({
				id: 'job-timeout',
				status: 'running',
				progress: null,
			});
			mocks.videoStatus.mockReset().mockResolvedValue({
				id: 'job-timeout',
				status: 'running',
				progress: 50,
			});

			const relay = startVideoRelay(
				baseParams({
					conversationId: conv.id,
					userId: user.id,
					userMessage: userMessage as ChatMessage,
					onComplete,
				}),
			);

			const drainPromise = drain(relay);

			// Advance far past MAX_WAIT_MS (20 min) so the sleep/poll
			// loop accumulates enough time to trip the expiry check.
			await vi.advanceTimersByTimeAsync(20 * 60_000 + 60_000);

			const events = await drainPromise;

			// Must cancel the bridge job before giving up on it
			expect(mocks.videoCancel).toHaveBeenCalledWith(endpoint(), 'job-timeout');

			// The timeout surfaces as an error, not a done event
			const err = events.find((e) => e.type === 'error') as { message: string } | undefined;
			expect(err).toBeDefined();
			expect(err!.message).toContain('did not complete');
			expect(events.some((e) => e.type === 'done')).toBe(false);

			// The relay still releases the slot and fires onComplete
			expect(onComplete).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});
});
