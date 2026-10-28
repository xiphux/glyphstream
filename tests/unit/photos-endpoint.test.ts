/**
 * The texting photo routes: POST /api/conversations/:id/photos (develop one
 * of a reply's `[photo: …]`) and PATCH …/photos/:photoId (put a version on
 * show, or pick one from a comparison).
 *
 * Real in-memory DB; the job runner is mocked at `submitGenerationJob` — what
 * it does with the job is generation-jobs.test.ts's business. Here: what the
 * route accepts, and the job it asks for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';
import type { SubmitGenerationJob } from '#lib/server/generation/jobs.js';

const mocks = vi.hoisted(() => ({
	submit: vi.fn<(job: SubmitGenerationJob) => ReadableStream<Uint8Array>>(),
	listAllModels: vi.fn<() => Promise<unknown[]>>(),
}));

vi.mock('#lib/server/generation/jobs.js', () => ({
	submitGenerationJob: (job: SubmitGenerationJob) => mocks.submit(job),
	closePhotoComparison: () => {},
}));
vi.mock('#lib/server/endpoints/registry.js', () => ({
	getEndpoint: (id: string) => (id === 'ep' || id === 'local' ? { id } : undefined),
}));
vi.mock('#lib/server/endpoints/list-models.js', () => ({
	listAllModels: () => mocks.listAllModels(),
}));

import { GET, POST } from '../../src/routes/api/conversations/[id]/photos/+server';
import { PATCH } from '../../src/routes/api/conversations/[id]/photos/[photoId]/+server';
import { createConversation } from '#lib/server/db/queries/conversations.js';
import { appendMessage } from '#lib/server/db/queries/messages.js';
import { insertMedia } from '#lib/server/db/queries/media.js';
import {
	insertMessageImage,
	listImagesForMessages,
} from '#lib/server/db/queries/message-images.js';
import { modelStatsDaily } from '#lib/server/db/schema.js';
import { insertGenerationJob } from '#lib/server/db/queries/generation-jobs.js';
import { getDb } from '#lib/server/db/client.js';

let db: TestDB;
let userId: string;
let convId: string;
let replyId: string;

beforeEach(() => {
	db = createTestDb();
	userId = seedUser().id;
	convId = createConversation({
		userId,
		endpointId: 'local',
		modelId: 'local::chat',
		modelKind: 'chat',
		replyStyle: 'texting',
	}).id;
	const user = appendMessage({
		conversationId: convId,
		parentMessageId: null,
		role: 'user',
		parts: [{ type: 'text', text: 'send pics' }],
	});
	replyId = appendMessage({
		conversationId: convId,
		parentMessageId: user.id,
		role: 'assistant',
		parts: [
			{ type: 'text', text: 'ok!\n\n[photo: me at the beach]\n\nSam: [photo: the dog, 9:16]' },
		],
	}).id;
	mocks.submit.mockReset().mockReturnValue(new ReadableStream({ start: (c) => c.close() }));
	mocks.listAllModels.mockReset().mockResolvedValue([
		{
			id: 'ep::sdxl',
			kind: 'image',
			aspectRatios: [{ value: '1:1' }, { value: '3:4' }, { value: '9:16' }],
		},
		{ id: 'ep::flux', kind: 'image' },
		{ id: 'local::chat', kind: 'chat' },
	]);
});
afterEach(() => closeTestDb());

function develop(body: Record<string, unknown>, conversationId = convId, asUser = userId) {
	const request = new Request(`http://x/api/conversations/${conversationId}/photos`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ messageId: replyId, index: 0, modelId: 'ep::sdxl', ...body }),
	});
	return POST({
		locals: { user: { id: asUser } },
		params: { id: conversationId },
		request,
	} as unknown as Parameters<typeof POST>[0]);
}

function pick(photoId: string, body: Record<string, unknown> = { shown: true }) {
	const request = new Request(`http://x/api/conversations/${convId}/photos/${photoId}`, {
		method: 'PATCH',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	return PATCH({
		locals: { user: { id: userId } },
		params: { id: convId, photoId },
		request,
	} as unknown as Parameters<typeof PATCH>[0]);
}

const submitted = () => mocks.submit.mock.calls.at(-1)![0];

let seq = 0;
function version(
	over: { modelId?: string; mediaId?: string | null; error?: string; comparisonId?: string } = {},
) {
	const id = `v${++seq}`;
	const mediaId =
		over.mediaId === undefined
			? insertMedia({
					userId,
					storagePath: `generated/${id}.png`,
					contentType: 'image/png',
					byteSize: 1,
					kind: 'image',
					sourceEndpointId: 'ep',
					sourceModel: over.modelId ?? 'ep::sdxl',
					promptExcerpt: 'x',
				}).id
			: over.mediaId;
	getDb().transaction((tx) =>
		insertMessageImage(tx, {
			id,
			userId,
			conversationId: convId,
			messageId: replyId,
			kind: 'photo',
			markerIndex: 0,
			mediaId,
			modelId: over.modelId ?? 'ep::sdxl',
			error: over.error ?? null,
			shownAt: null,
			comparisonId: over.comparisonId ?? null,
			createdAt: seq,
		}),
	);
	return id;
}

describe('POST /photos', () => {
	it('develops a marker on the reply, from its description', async () => {
		await develop({ index: 1, aspectRatio: '9:16' });
		expect(submitted()).toMatchObject({
			conversationId: convId,
			anchorMessageId: replyId,
			origin: 'photo',
			modelId: 'ep::sdxl',
			params: {
				prompt: 'the dog, 9:16',
				aspectRatio: '9:16',
				displayOnly: true,
				photo: { sourceMessageId: replyId, index: 1, speaker: 'Sam' },
			},
		});
		expect(submitted().params.compareId).toBeUndefined();
	});

	it('draws the prompt the user left, in the nearest shape the model offers', async () => {
		await develop({
			prompt: 'me at the beach, golden hour',
			aspectRatio: '2:3',
			compare: 'cmp-1',
		});
		expect(submitted().params).toMatchObject({
			prompt: 'me at the beach, golden hour',
			aspectRatio: '3:4',
			compareId: 'cmp-1',
		});
	});

	it('clears a failed attempt, which the new one replaces', async () => {
		version({ mediaId: null, error: 'boom' });
		await develop({});
		expect(listImagesForMessages(convId, [replyId]).get(replyId)).toBeUndefined();
	});

	it('leaves a comparison’s own failures for its next draw, clearing older ones', async () => {
		const own = version({ mediaId: null, error: 'boom', comparisonId: 'cmp-1' });
		version({ mediaId: null, error: 'old' });
		await develop({ compare: 'cmp-1' });
		expect((listImagesForMessages(convId, [replyId]).get(replyId) ?? []).map((v) => v.id)).toEqual([
			own,
		]);
	});

	it.each([
		['a marker the reply does not have', { index: 2 }, 404],
		['a reply that is not there', { messageId: 'nope' }, 404],
		['a chat model', { modelId: 'local::chat' }, 400],
		['an unknown endpoint', { modelId: 'gone::x' }, 400],
		['a malformed index', { index: -1 }, 400],
		['a malformed comparison id', { compare: 'a b' }, 400],
	])('refuses %s', async (_label, body, status) => {
		await expect(develop(body)).rejects.toMatchObject({ status });
		expect(mocks.submit).not.toHaveBeenCalled();
	});

	it('refuses a reply from someone else’s conversation', async () => {
		const stranger = seedUser().id;
		await expect(develop({}, convId, stranger)).rejects.toMatchObject({ status: 404 });
	});
});

describe('GET /photos', () => {
	function status(messages: string, asUser = userId) {
		const url = new URL(`http://x/api/conversations/${convId}/photos?messages=${messages}`);
		return GET({
			locals: { user: { id: asUser } },
			params: { id: convId },
			url,
		} as unknown as Parameters<typeof GET>[0]) as Response;
	}

	it('gives the photo state of the replies asked about', async () => {
		insertGenerationJob({
			id: 'j1',
			userId,
			conversationId: convId,
			anchorMessageId: replyId,
			kind: 'image',
			origin: 'photo',
			modelId: 'ep::sdxl',
			fanoutIndex: null,
			paramsJson: JSON.stringify({ photo: { sourceMessageId: replyId, index: 0 } }),
			createdAt: 1,
		});
		const v = version();
		expect(await status(replyId).json()).toMatchObject({
			developing: 1,
			replies: {
				[replyId]: {
					images: [{ id: v, markerIndex: 0, shown: true }],
					developing: [{ markerIndex: 0, modelId: 'ep::sdxl' }],
				},
			},
		});
		// Every reply asked about has an entry, empty where there's nothing.
		expect(await status('other').json()).toEqual({
			developing: 0,
			replies: { other: { images: [], developing: [] } },
		});
	});

	it('refuses someone else’s conversation', () => {
		expect(() => status(replyId, seedUser().id)).toThrow(expect.objectContaining({ status: 404 }));
	});
});

describe('PATCH /photos/:id', () => {
	const shown = () =>
		(listImagesForMessages(convId, [replyId]).get(replyId) ?? [])
			.filter((v) => v.shown)
			.map((v) => v.id);

	it('puts a version on show', async () => {
		const a = version();
		version();
		await pick(a);
		expect(shown()).toEqual([a]);
	});

	it('refuses a failed attempt, which has nothing to show', async () => {
		const failed = version({ mediaId: null, error: 'boom' });
		await expect(pick(failed)).rejects.toMatchObject({ status: 404 });
	});

	const tally = () =>
		Object.fromEntries(
			db
				.select()
				.from(modelStatsDaily)
				.all()
				.map((r) => [`${r.modelId} ${r.metric}`, r.count]),
		);

	it('counts a comparison pick for every model in it, the winner once more', async () => {
		version({ modelId: 'ep::sdxl', comparisonId: 'cmp-1' });
		const b = version({ modelId: 'ep::flux', comparisonId: 'cmp-1' });
		// Not in this comparison, so not counted.
		version({ modelId: 'ep::other' });
		await pick(b, { shown: true, pick: true });
		expect(tally()).toEqual({
			'sdxl fanout_shown': 1,
			'flux fanout_shown': 1,
			'flux fanout_win': 1,
		});
	});

	it('counts a comparison once, however often it is picked from', async () => {
		const a = version({ modelId: 'ep::sdxl', comparisonId: 'cmp-1' });
		const b = version({ modelId: 'ep::flux', comparisonId: 'cmp-1' });
		await pick(b, { shown: true, pick: true });
		await pick(b, { shown: true, pick: true });
		await pick(a, { shown: true, pick: true });
		expect(tally()).toEqual({
			'sdxl fanout_shown': 1,
			'flux fanout_shown': 1,
			'flux fanout_win': 1,
		});
	});

	it('counts nothing for versions that were not drawn as a comparison', async () => {
		const a = version({ modelId: 'ep::sdxl' });
		version({ modelId: 'ep::flux' });
		await pick(a, { shown: true, pick: true });
		expect(db.select().from(modelStatsDaily).all()).toEqual([]);
	});
});
