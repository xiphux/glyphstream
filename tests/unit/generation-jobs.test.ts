/**
 * Durable media generation jobs — `server/generation/jobs.ts`.
 *
 * The property the whole module exists for: a generation that was queued or
 * running when GlyphStream stopped comes back when it starts again, exactly
 * once. "After a restart" here is what a new process sees: a fresh gate, an
 * empty in-flight registry and a runner that hasn't resumed, with rows a
 * previous process left in the database (see `leftover`).
 *
 * Real in-memory DB, real gate, real relay; the upstream client, the persister
 * and the media link are mocked, as in image-relay.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({
	testDb: null as unknown as TestDB,
	imageGeneration: vi.fn(),
	persistGeneratedImage: vi.fn(),
	linkMessageMedia: vi.fn(),
	notify: vi.fn(async () => {}),
	getImageEnhancerModel: vi.fn(),
	enhancePrompt: vi.fn(),
	notifyFanout: vi.fn(),
	unlinkMediaFiles: vi.fn(async () => {}),
	endpoint: null as unknown as import('$lib/server/endpoints/config').LoadedEndpoint | undefined,
}));

vi.mock('$lib/server/db/client', () => ({ getDb: () => mocks.testDb, closeDb: () => {} }));
vi.mock('$lib/server/endpoints/client', async (orig) => ({
	...(await orig<typeof import('$lib/server/endpoints/client')>()),
	imageGeneration: mocks.imageGeneration,
}));
vi.mock('$lib/server/endpoints/registry', () => ({
	getEndpoint: (id: string) => (mocks.endpoint?.id === id ? mocks.endpoint : undefined),
}));
vi.mock('$lib/server/media/persister', () => ({
	persistGeneratedImage: mocks.persistGeneratedImage,
}));
vi.mock('$lib/server/db/queries/media', async (orig) => ({
	...(await orig<typeof import('$lib/server/db/queries/media')>()),
	linkMessageMedia: mocks.linkMessageMedia,
}));
vi.mock('$lib/server/push/notify', () => ({ notifyConversationComplete: mocks.notify }));
vi.mock('$lib/server/media/disk-store', () => ({ unlinkMediaFiles: mocks.unlinkMediaFiles }));
vi.mock('$lib/server/messages/fanout-notify', () => ({
	notifyFanoutCompleteIfLast: mocks.notifyFanout,
}));
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

import { createConversation, deleteConversation } from '$lib/server/db/queries/conversations';
import { appendMessage, getSiblingAssistants } from '$lib/server/db/queries/messages';
import { generationJobs, media } from '$lib/server/db/schema';
import { insertMedia } from '$lib/server/db/queries/media';
import { insertGenerationJob } from '$lib/server/db/queries/generation-jobs';
import {
	resetEndpointGatesForTests,
	setResourceGroupPaused,
} from '$lib/server/endpoints/concurrency';
import type { LoadedEndpoint } from '$lib/server/endpoints/config';
import {
	resetGenerationJobsForTests,
	resumeGenerationJobs,
	submitGenerationJob,
	type SubmitGenerationJob,
} from '$lib/server/generation/jobs';
import {
	getInFlightEntries,
	getInFlightSince,
	resetInFlight,
} from '$lib/server/streaming/in-flight';
import type { StreamEvent } from '$lib/types/api';

function endpoint(maxConcurrent = 1): LoadedEndpoint {
	return {
		id: 'bridge',
		resourceGroup: 'bridge',
		resourceGroupMaxConcurrent: maxConcurrent,
		release: null,
		displayName: 'Bridge',
		baseUrl: 'http://localhost/v1',
		apiKey: null,
		requestTimeoutSeconds: 120,
		providerQuirk: 'passthrough',
		groupBy: 'endpoint',
		supportsTools: false,
		maxConcurrent,
		contextWindow: null,
		modelContextWindows: {},
		modelPromptStyles: {},
		modelPromptHints: {},
	};
}

beforeEach(() => {
	mocks.testDb = createTestDb();
	mocks.endpoint = endpoint();
	mocks.imageGeneration.mockReset().mockResolvedValue({ data: [{ url: 'http://img/out.png' }] });
	mocks.persistGeneratedImage.mockReset().mockResolvedValue('media-out');
	mocks.linkMessageMedia.mockReset();
	mocks.notify.mockReset().mockResolvedValue(undefined);
	mocks.getImageEnhancerModel.mockReset().mockReturnValue(null);
	mocks.enhancePrompt.mockReset();
	mocks.notifyFanout.mockReset();
	mocks.unlinkMediaFiles.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
	resetGenerationJobsForTests();
	resetEndpointGatesForTests();
	resetInFlight();
	closeTestDb();
});

let leftoverSeq = 0;
/**
 * A row a previous process left behind. Written directly rather than by
 * submitting and "restarting": a submitted job's run is still alive in THIS
 * process, and a real restart has no such survivor to race the resumed copy.
 */
function leftover(
	s: ReturnType<typeof seed>,
	over: Partial<typeof generationJobs.$inferInsert> & { prompt?: string } = {},
) {
	const { prompt, ...cols } = over;
	insertGenerationJob({
		id: `left-${++leftoverSeq}`,
		userId: s.user.id,
		conversationId: s.conv.id,
		anchorMessageId: s.userMessage.id,
		kind: 'image',
		origin: 'send',
		modelId: 'bridge::sdxl',
		fanoutIndex: null,
		paramsJson: JSON.stringify({ ...job(s).params, prompt: prompt ?? 'a cat' }),
		createdAt: Date.now(),
		...cols,
	});
}

function seed(prompt = 'a cat') {
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
		parts: [{ type: 'text', text: prompt }],
	});
	return { user, conv, userMessage };
}

function job(
	s: ReturnType<typeof seed>,
	over: Partial<SubmitGenerationJob> = {},
): SubmitGenerationJob {
	return {
		userId: s.user.id,
		conversationId: s.conv.id,
		anchorMessageId: s.userMessage.id,
		kind: 'image',
		origin: 'send',
		modelId: 'bridge::sdxl',
		fanoutIndex: null,
		params: {
			prompt: 'a cat',
			dispatchMediaIds: [],
			sourceMediaId: null,
			enhancementEnabled: false,
			promptStyle: null,
			promptHint: null,
		},
		...over,
	};
}

function jobRows() {
	return mocks.testDb.select().from(generationJobs).all();
}

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

async function until(cond: () => boolean, what: string) {
	for (let i = 0; i < 200; i++) {
		if (cond()) return;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error(`timed out waiting for ${what}`);
}

describe('a submitted job', () => {
	it('streams the relay events, lands the result, and leaves no row behind', async () => {
		const s = seed();
		const events = await drain(submitGenerationJob(job(s)));
		expect(events.map((e) => e.type)).toEqual(['start', 'done']);
		const [result] = getSiblingAssistants(s.conv.id, s.userMessage.id);
		expect(result.parts).toEqual([{ type: 'image', mediaId: 'media-out' }]);
		expect(jobRows()).toEqual([]);
		expect(getInFlightSince(s.conv.id)).toBeNull();
	});

	it('persists a failure as an error column, and leaves no row behind', async () => {
		const s = seed();
		mocks.imageGeneration.mockRejectedValue(new Error('upstream exploded'));
		const events = await drain(submitGenerationJob(job(s)));
		expect(events.at(-1)).toMatchObject({ type: 'error', message: 'upstream exploded' });
		const [result] = getSiblingAssistants(s.conv.id, s.userMessage.id);
		expect(result.parts[0]).toMatchObject({ type: 'error', message: 'upstream exploded' });
		expect(jobRows()).toEqual([]);
	});

	it('is a row while it waits, and Stop removes it', async () => {
		const s = seed();
		setResourceGroupPaused(endpoint(), true);
		const stream = submitGenerationJob(job(s));
		expect(jobRows()).toHaveLength(1);
		expect(jobRows()[0].state).toBe('queued');

		getInFlightEntries(s.conv.id)[0].controller.abort();
		const events = await drain(stream);
		expect(events.at(-1)).toMatchObject({ type: 'error', message: 'Cancelled' });
		expect(jobRows()).toEqual([]);
		expect(getSiblingAssistants(s.conv.id, s.userMessage.id)).toEqual([]);
	});

	it('is marked running once its slot is granted', async () => {
		const s = seed();
		let release!: () => void;
		mocks.imageGeneration.mockReturnValue(
			new Promise((r) => {
				release = () => r({ data: [{ url: 'http://img/out.png' }] });
			}),
		);
		const stream = submitGenerationJob(job(s));
		await until(() => jobRows()[0]?.state === 'running', 'the job to start');
		expect(jobRows()[0].startedAt).not.toBeNull();
		release();
		await drain(stream);
	});

	it('checkpoints the enhanced prompt so a resumed run needn’t redo it', async () => {
		const s = seed();
		setResourceGroupPaused(endpoint(), true);
		// On its own endpoint — the image endpoint is paused.
		mocks.getImageEnhancerModel.mockReturnValue({
			endpoint: { ...endpoint(), id: 'utility', resourceGroup: 'utility' },
			upstreamId: 'gemma',
		});
		mocks.enhancePrompt.mockResolvedValue({ enhanced: 'a regal cat, oil painting', changed: true });
		void submitGenerationJob(job(s, { params: { ...job(s).params, enhancementEnabled: true } }));
		await until(() => jobRows()[0]?.preparedJson !== null, 'the enhancement checkpoint');
		expect(JSON.parse(jobRows()[0].preparedJson!)).toEqual({
			effectivePrompt: 'a regal cat, oil painting',
			originalPrompt: 'a cat',
		});
	});
});

describe('after a restart', () => {
	it('resumes a queued job and completes it', async () => {
		const s = seed();
		leftover(s);

		resumeGenerationJobs();
		// Back in flight straight away, so a page load sees it as queued.
		expect(getInFlightSince(s.conv.id)).not.toBeNull();
		await until(() => jobRows().length === 0, 'the resumed job to finish');
		const [result] = getSiblingAssistants(s.conv.id, s.userMessage.id);
		expect(result.parts).toEqual([{ type: 'image', mediaId: 'media-out' }]);
		expect(mocks.imageGeneration).toHaveBeenCalledOnce();
	});

	it('resumes jobs in the order they were submitted', async () => {
		const a = seed('first');
		const b = seed('second');
		// Same millisecond, as a grid's branches can be: rowid breaks the tie.
		leftover(a, { prompt: 'first', createdAt: 1000 });
		leftover(b, { prompt: 'second', createdAt: 1000 });

		resumeGenerationJobs();
		await until(() => jobRows().length === 0, 'both jobs to finish');
		const prompts = mocks.imageGeneration.mock.calls.map(
			(c) => (c[1] as { prompt: string }).prompt,
		);
		expect(prompts).toEqual(['first', 'second']);
	});

	it('uses the checkpointed prompt instead of enhancing again', async () => {
		const s = seed();
		leftover(s, {
			preparedJson: JSON.stringify({ effectivePrompt: 'enhanced', originalPrompt: 'a cat' }),
			paramsJson: JSON.stringify({ ...job(s).params, enhancementEnabled: true }),
		});
		mocks.getImageEnhancerModel.mockReturnValue({ endpoint: endpoint(), upstreamId: 'gemma' });

		resumeGenerationJobs();
		await until(() => jobRows().length === 0, 'the resumed job to finish');
		expect(mocks.enhancePrompt).not.toHaveBeenCalled();
		expect(mocks.imageGeneration.mock.calls[0][1]).toMatchObject({ prompt: 'enhanced' });
	});

	it('re-runs a job interrupted mid-generation once', async () => {
		const s = seed();
		// The process died after the slot was granted.
		leftover(s, { state: 'running', startedAt: 1 });
		setResourceGroupPaused(endpoint(), true);

		resumeGenerationJobs();
		expect(jobRows()[0]).toMatchObject({ state: 'queued', attempts: 1, startedAt: null });
		setResourceGroupPaused(endpoint(), false);
		await until(() => jobRows().length === 0, 'the re-run to finish');
		expect(getSiblingAssistants(s.conv.id, s.userMessage.id)[0].parts[0]).toMatchObject({
			type: 'image',
		});
	});

	it('fails a job interrupted a second time instead of running it again', async () => {
		const s = seed();
		leftover(s, { state: 'running', attempts: 1 });

		resumeGenerationJobs();
		await until(() => jobRows().length === 0, 'the job to be failed');
		expect(mocks.imageGeneration).not.toHaveBeenCalled();
		expect(getSiblingAssistants(s.conv.id, s.userMessage.id)[0].parts[0]).toMatchObject({
			type: 'error',
			message: 'Generation was interrupted by a server restart',
		});
	});

	it('fails a job whose model is no longer configured', async () => {
		const s = seed();
		leftover(s);
		mocks.endpoint = undefined;

		resumeGenerationJobs();
		expect(jobRows()).toEqual([]);
		expect(getSiblingAssistants(s.conv.id, s.userMessage.id)[0].parts[0]).toMatchObject({
			type: 'error',
			message: 'Model "bridge::sdxl" is no longer configured',
		});
	});

	it('tries again when reading the queue fails', () => {
		const s = seed();
		leftover(s);
		setResourceGroupPaused(endpoint(), true);
		const real = mocks.testDb;
		mocks.testDb = {
			select: () => {
				throw new Error('database is locked');
			},
		} as unknown as TestDB;
		const err = vi.spyOn(console, 'error').mockImplementation(() => {});
		resumeGenerationJobs();
		expect(getInFlightEntries(s.conv.id)).toEqual([]);
		err.mockRestore();

		// A transient failure must not have marked the queue as taken back.
		mocks.testDb = real;
		resumeGenerationJobs();
		expect(getInFlightEntries(s.conv.id)).toHaveLength(1);
	});

	it('only resumes once per process', async () => {
		const s = seed();
		leftover(s);
		setResourceGroupPaused(endpoint(), true);

		resumeGenerationJobs();
		resumeGenerationJobs();
		expect(getInFlightEntries(s.conv.id)).toHaveLength(1);
	});

	it('does not resume again when the module is re-evaluated (a dev hot reload)', async () => {
		const s = seed();
		leftover(s);
		setResourceGroupPaused(endpoint(), true);
		resumeGenerationJobs();

		vi.resetModules();
		const fresh = await import('$lib/server/generation/jobs');
		const freshInFlight = await import('$lib/server/streaming/in-flight');
		fresh.resumeGenerationJobs();
		// The job is still this process's live one — not taken back a second time.
		expect(freshInFlight.getInFlightEntries(s.conv.id)).toEqual([]);
		expect(getInFlightEntries(s.conv.id)[0].controller.signal.aborted).toBe(false);
	});

	it('keeps the leftover queue ahead of work submitted after the restart', async () => {
		const old = seed('leftover');
		leftover(old, { prompt: 'leftover' });

		// No explicit resume: the first submit after a restart triggers it.
		const fresh = seed('fresh');
		await drain(
			submitGenerationJob(job(fresh, { params: { ...job(fresh).params, prompt: 'fresh' } })),
		);
		await until(() => jobRows().length === 0, 'both jobs to finish');
		const prompts = mocks.imageGeneration.mock.calls.map(
			(c) => (c[1] as { prompt: string }).prompt,
		);
		expect(prompts).toEqual(['leftover', 'fresh']);
	});
});

describe('a job whose anchor goes away', () => {
	it('is deleted with its conversation', () => {
		const s = seed();
		setResourceGroupPaused(endpoint(), true);
		void submitGenerationJob(job(s));
		deleteConversation(s.conv.id, s.user.id);
		expect(jobRows()).toEqual([]);
	});

	it('abandons the generation rather than landing a result with nowhere to go', async () => {
		const s = seed();
		setResourceGroupPaused(endpoint(), true);
		const stream = submitGenerationJob(job(s));
		// The row vanishes while the job waits in line — the cascade from a
		// branch delete, reduced to its effect.
		mocks.testDb
			.delete(generationJobs)
			.where(eq(generationJobs.anchorMessageId, s.userMessage.id))
			.run();
		setResourceGroupPaused(endpoint(), false);

		const events = await drain(stream);
		expect(events.at(-1)).toMatchObject({ type: 'error', message: 'Cancelled' });
		expect(getSiblingAssistants(s.conv.id, s.userMessage.id)).toEqual([]);
	});

	it('deletes the media it generated when the result is discarded', async () => {
		const s = seed();
		// A real media row this time, so its fate is observable.
		mocks.persistGeneratedImage.mockImplementation(async () => {
			return insertMedia({
				userId: s.user.id,
				storagePath: 'generated/out.png',
				contentType: 'image/png',
				byteSize: 16,
				kind: 'image',
				sourceEndpointId: 'bridge',
				sourceModel: 'bridge::sdxl',
				promptExcerpt: 'a cat',
			}).id;
		});
		let release!: () => void;
		mocks.imageGeneration.mockReturnValue(
			new Promise((r) => {
				release = () => r({ data: [{ url: 'http://img/out.png' }] });
			}),
		);
		const stream = submitGenerationJob(job(s));
		await until(() => jobRows()[0]?.state === 'running', 'the job to start');
		// Deleted mid-generation: the result will have nowhere to land.
		mocks.testDb.delete(generationJobs).run();
		release();

		const events = await drain(stream);
		expect(events.at(-1)).toMatchObject({ type: 'error', message: 'Cancelled' });
		const [row] = mocks.testDb.select().from(media).all();
		expect(row.hardDeletedAt).not.toBeNull();
		expect(mocks.unlinkMediaFiles).toHaveBeenCalledWith(
			[{ id: row.id, storagePath: 'generated/out.png' }],
			'media-relay.discard',
		);
	});
});

describe('a grid branch', () => {
	it('survives a failing notification on a resumed run', async () => {
		// Nobody awaits a resumed run, so a throw escaping its cleanup would be an
		// unhandled rejection — which vitest fails the run on, as Node would crash.
		const s = seed();
		// An early exit — the source frame of this image-to-video branch is gone —
		// so the runner's own cleanup is what settles it, not the relay's.
		leftover(s, {
			origin: 'fanout',
			kind: 'video',
			fanoutIndex: 0,
			paramsJson: JSON.stringify({ ...job(s).params, dispatchMediaIds: ['vanished-media'] }),
		});
		mocks.notifyFanout.mockImplementation(() => {
			throw new Error('push service down');
		});
		const err = vi.spyOn(console, 'error').mockImplementation(() => {});

		resumeGenerationJobs();
		await until(() => jobRows().length === 0, 'the resumed branch to finish');
		await until(() => getInFlightEntries(s.conv.id).length === 0, 'the registry to clear');
		expect(err).toHaveBeenCalled();
		err.mockRestore();
	});

	it('registers per job, pins the leaf, and defers to the aggregate notification', async () => {
		const s = seed();
		setResourceGroupPaused(endpoint(), true);
		void submitGenerationJob(job(s, { origin: 'fanout', fanoutIndex: 0 }));
		void submitGenerationJob(job(s, { origin: 'fanout', fanoutIndex: 1 }));
		// Neither supersedes the other.
		expect(getInFlightEntries(s.conv.id)).toHaveLength(2);

		setResourceGroupPaused(endpoint(), false);
		await until(() => jobRows().length === 0, 'both branches to finish');
		const siblings = getSiblingAssistants(s.conv.id, s.userMessage.id);
		expect(siblings.map((m) => m.fanoutIndex)).toEqual([0, 1]);
		expect(mocks.notify).not.toHaveBeenCalled();
		expect(mocks.notifyFanout).toHaveBeenCalled();
	});

	it('still counts toward its grid after a restart', async () => {
		const s = seed();
		const paramsJson = JSON.stringify({ ...job(s).params, fanoutSize: 2 });
		leftover(s, { origin: 'fanout', fanoutIndex: 0, paramsJson });
		leftover(s, { origin: 'fanout', fanoutIndex: 1, paramsJson });
		setResourceGroupPaused(endpoint(), true);

		resumeGenerationJobs();
		// Both back as turn entries — what the recovered grid's pending columns
		// and the aggregate's "am I last" both read.
		expect(getInFlightEntries(s.conv.id)).toHaveLength(2);
		setResourceGroupPaused(endpoint(), false);
		await until(() => jobRows().length === 0, 'both branches to finish');
		expect(mocks.notifyFanout.mock.calls.at(-1)?.[0]).toMatchObject({ fanoutSize: 2 });
	});
});
