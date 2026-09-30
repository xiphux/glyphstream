/**
 * POST /api/conversations/[id]/messages — the image / video path, which queues
 * a durable generation job (see server/generation/jobs.ts) instead of running a
 * relay itself.
 *
 * What the route owes the job is everything a resumed run will need without a
 * route to ask: the origin (which decides leaf handling, registry keying and
 * notification), the grid position and size, and the per-model inputs resolved
 * NOW — a job resumed after a restart must run with what was asked for, not with
 * whatever the catalogue says later. The runner itself is covered by
 * generation-jobs.test.ts; here it is mocked, and the job the route submits is
 * the assertion.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_FANOUT_BRANCHES_PER_CONVERSATION } from '$lib/fanout';
import type { LoadedEndpoint } from '$lib/server/endpoints/config';
import type { SubmitGenerationJob } from '$lib/server/generation/jobs';
import { registerInFlight, resetInFlight } from '$lib/server/streaming/in-flight';

const mocks = vi.hoisted(() => ({
	getConversationMeta: vi.fn<(...a: unknown[]) => unknown>(),
	createUserMessage: vi.fn<(...a: unknown[]) => unknown>(),
	getMessage: vi.fn<(...a: unknown[]) => unknown>(),
	getEndpoint: vi.fn<(...a: unknown[]) => unknown>(),
	listAllModels: vi.fn<(...a: unknown[]) => unknown>(),
	submitGenerationJob: vi.fn<(input: SubmitGenerationJob) => ReadableStream<Uint8Array>>(),
}));

vi.mock('$lib/server/db/queries/conversations', () => ({
	getConversationMeta: (...a: unknown[]) => mocks.getConversationMeta(...a),
	updateConversationModel: () => {},
}));
vi.mock('$lib/server/db/queries/messages', async (orig) => ({
	...(await orig<typeof import('$lib/server/db/queries/messages')>()),
	getMessage: (...a: unknown[]) => mocks.getMessage(...a),
}));
vi.mock('$lib/server/messages/create-user-message', () => ({
	createUserMessage: (...a: unknown[]) => mocks.createUserMessage(...a),
}));
vi.mock('$lib/server/endpoints/registry', () => ({
	getEndpoint: (...a: unknown[]) => mocks.getEndpoint(...a),
}));
vi.mock('$lib/server/endpoints/list-models', () => ({
	listAllModels: (...a: unknown[]) => mocks.listAllModels(...a),
}));
vi.mock('$lib/server/generation/jobs', () => ({
	submitGenerationJob: (input: SubmitGenerationJob) => mocks.submitGenerationJob(input),
}));

import { POST } from '../../src/routes/api/conversations/[id]/messages/+server';

function meta(modelKind: 'image' | 'video', disabledFeatures: string[] = []) {
	return {
		id: 'c1',
		title: 'T',
		modelId: modelKind === 'image' ? 'ep::sdxl' : 'ep::wan',
		modelKind,
		endpointId: 'ep',
		activeLeafMessageId: null,
		systemPrompt: null,
		private: false,
		disabledFeatures,
	};
}

function call(body: Record<string, unknown>) {
	const url = new URL('http://x/api/conversations/c1/messages?stream=1');
	const request = new Request(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	return POST({
		locals: { user: { id: 'u1' } },
		params: { id: 'c1' },
		request,
		url,
	} as unknown as Parameters<typeof POST>[0]);
}

/** The job the route submitted on its most recent call. */
function submitted(): SubmitGenerationJob {
	const c = mocks.submitGenerationJob.mock.calls.at(-1);
	if (!c) throw new Error('submitGenerationJob was never called');
	return c[0];
}

beforeEach(() => {
	mocks.getConversationMeta.mockReset().mockReturnValue(meta('image'));
	mocks.createUserMessage.mockReset().mockReturnValue({
		id: 'um1',
		role: 'user',
		parts: [{ type: 'text', text: 'a lighthouse at dusk' }],
	});
	mocks.getMessage.mockReset();
	mocks.getEndpoint.mockReset().mockReturnValue({ id: 'ep' });
	mocks.listAllModels.mockReset().mockResolvedValue([
		{
			id: 'ep::sdxl',
			kind: 'image',
			displayName: 'SDXL',
			promptStyle: 'booru-tags',
			promptHint: 'no text',
			aspectRatios: [{ value: '16:9', label: 'Wide' }],
		},
		{ id: 'ep::wan', kind: 'video', displayName: 'Wan', promptStyle: 'cinematic-prose' },
	]);
	mocks.submitGenerationJob.mockReset().mockReturnValue(new ReadableStream<Uint8Array>());
});

afterEach(() => resetInFlight());

describe('a single send', () => {
	it('queues a `send` job anchored on the new user message and streams it', async () => {
		const res = await call({ text: 'a lighthouse at dusk' });
		expect(res.headers.get('content-type')).toBe('text/event-stream');
		expect(submitted()).toMatchObject({
			userId: 'u1',
			conversationId: 'c1',
			anchorMessageId: 'um1',
			kind: 'image',
			origin: 'send',
			modelId: 'ep::sdxl',
			fanoutIndex: null,
		});
	});

	it('resolves the model’s prompt style and the requested ratio at submit time', async () => {
		await call({ text: 'a lighthouse at dusk', aspectRatio: '16:9' });
		expect(submitted().params).toEqual({
			prompt: 'a lighthouse at dusk',
			dispatchMediaIds: [],
			sourceMediaId: null,
			aspectRatio: '16:9',
			enhancementEnabled: true,
			promptStyle: 'booru-tags',
			promptHint: 'no text',
			fanoutSize: undefined,
		});
	});

	it('stores no prompt style when the conversation has enhancement off', async () => {
		mocks.getConversationMeta.mockReturnValue(meta('image', ['image_prompt_enhancement']));
		await call({ text: 'a lighthouse at dusk' });
		expect(submitted().params).toMatchObject({
			enhancementEnabled: false,
			promptStyle: null,
			promptHint: null,
		});
	});

	it('queues a video job, gated on the VIDEO enhancement toggle', async () => {
		mocks.getConversationMeta.mockReturnValue(meta('video', ['image_prompt_enhancement']));
		await call({ text: 'a dog running' });
		expect(submitted()).toMatchObject({ kind: 'video', modelId: 'ep::wan' });
		// The image toggle is off, the video one isn't — the video's is what counts.
		expect(submitted().params).toMatchObject({
			enhancementEnabled: true,
			promptStyle: 'cinematic-prose',
		});
	});
});

describe('a grid branch', () => {
	beforeEach(() => {
		mocks.getMessage.mockReturnValue({
			id: 'shared',
			role: 'user',
			parts: [
				{ type: 'text', text: 'the same cat' },
				{ type: 'image', mediaId: 'in-a' },
				{ type: 'image', mediaId: 'in-b' },
			],
		});
	});

	it('queues a `fanout` job with its grid position, size and split input', async () => {
		await call({
			fanoutBranch: true,
			parentMessageId: 'shared',
			branchIndex: 2,
			fanoutSize: 4,
			// `smuggled` isn't attached to the parent, so it's dropped.
			inputMediaIds: ['in-b', 'smuggled'],
		});
		expect(submitted()).toMatchObject({
			anchorMessageId: 'shared',
			origin: 'fanout',
			fanoutIndex: 2,
		});
		expect(submitted().params).toMatchObject({
			prompt: 'the same cat',
			dispatchMediaIds: ['in-b'],
			sourceMediaId: 'in-b',
			fanoutSize: 4,
		});
		// A grid shares the user message /prepare created; it never makes one.
		expect(mocks.createUserMessage).not.toHaveBeenCalled();
	});

	it('still refuses a branch past the per-conversation ceiling', async () => {
		for (let i = 0; i < MAX_FANOUT_BRANCHES_PER_CONVERSATION; i++) {
			registerInFlight('c1', { id: 'ep' } as unknown as LoadedEndpoint, `filler-${i}`);
		}
		await expect(
			call({ fanoutBranch: true, parentMessageId: 'shared', branchIndex: 0 }),
		).rejects.toMatchObject({ status: 429 });
		expect(mocks.submitGenerationJob).not.toHaveBeenCalled();
	});
});
