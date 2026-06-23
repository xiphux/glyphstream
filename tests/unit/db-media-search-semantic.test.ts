import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB }));
vi.mock('$lib/server/db/client', () => ({
	getDb: () => mocks.testDb,
	closeDb: () => {},
}));

// The semantic leg pulls config + the query embedding from these; mock both so
// we control whether/what the dense leg ranks against (no real endpoint).
const resolveMock = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/retrieval/embeddings-config', () => ({ resolveRelevanceConfig: resolveMock }));
const embedQueryMock = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/retrieval/embed-rank', () => ({ embedQuery: embedQueryMock }));

import { insertMedia, searchMediaForUser, setMediaEmbedding } from '$lib/server/db/queries/media';
import { encodeVector } from '$lib/server/retrieval/vector';

const MODEL = 'embed-v1';
const CFG = {
	endpoint: { id: 'e', baseUrl: 'http://e', apiKey: null },
	modelId: MODEL,
	timeoutSeconds: 5,
	queryPrefix: '',
	documentPrefix: '',
	maxInputTokens: 512,
};

beforeEach(() => {
	mocks.testDb = createTestDb();
	resolveMock.mockReset();
	embedQueryMock.mockReset();
});
afterEach(() => closeTestDb());

function addMedia(userId: string, promptFull: string, vec?: number[], model = MODEL): string {
	const { id } = insertMedia({
		userId,
		storagePath: `ab/cd/${Math.random().toString(36).slice(2)}.png`,
		contentType: 'image/png',
		byteSize: 1024,
		kind: 'image',
		sourceEndpointId: 'bridge',
		sourceModel: 'comfyui/sdxl',
		promptExcerpt: promptFull,
		promptFull,
	});
	if (vec) setMediaEmbedding(id, promptFull, encodeVector(vec), model);
	return id;
}

describe('searchMediaForUser (semantic fusion)', () => {
	it('surfaces a synonym match the keyword leg misses', async () => {
		resolveMock.mockReturnValue(CFG);
		const u = seedUser();
		const puppy = addMedia(u.id, 'a golden retriever puppy', [1, 0]);
		addMedia(u.id, 'a sunny meadow', [0, 1]);
		// "dog" shares no token with either prompt, but embeds nearest the puppy.
		embedQueryMock.mockResolvedValue([1, 0]);

		const hits = await searchMediaForUser(u.id, 'dog');
		expect(hits[0].id).toBe(puppy); // dense nearest-neighbour first
		expect(embedQueryMock).toHaveBeenCalledOnce();
	});

	it('keeps keyword matches when embeddings are configured', async () => {
		resolveMock.mockReturnValue(CFG);
		const u = seedUser();
		const apple = addMedia(u.id, 'a red apple', [1, 0]);
		addMedia(u.id, 'a blue car', [0, 1]);
		embedQueryMock.mockResolvedValue([1, 0]);

		const hits = await searchMediaForUser(u.id, 'apple');
		expect(hits[0].id).toBe(apple); // lexical + dense both favour it
	});

	it('degrades to keyword-only when embeddings are not configured', async () => {
		resolveMock.mockReturnValue(undefined);
		const u = seedUser();
		const apple = addMedia(u.id, 'a red apple');
		addMedia(u.id, 'a blue car');

		const hits = await searchMediaForUser(u.id, 'apple');
		expect(hits.map((h) => h.id)).toEqual([apple]); // no dense neighbours added
		expect(embedQueryMock).not.toHaveBeenCalled();
	});

	it('degrades to keyword-only when the query embedding fails', async () => {
		resolveMock.mockReturnValue(CFG);
		const u = seedUser();
		const apple = addMedia(u.id, 'a red apple', [1, 0]);
		addMedia(u.id, 'a blue car', [0, 1]);
		embedQueryMock.mockResolvedValue(null); // endpoint down

		const hits = await searchMediaForUser(u.id, 'apple');
		expect(hits.map((h) => h.id)).toEqual([apple]); // only the lexical hit
	});

	it('degrades to keyword-only if a stored vector is malformed (no throw)', async () => {
		resolveMock.mockReturnValue(CFG);
		const u = seedUser();
		const apple = addMedia(u.id, 'a red apple');
		// 1-dim stored vector vs a 2-dim query → cosineRank→dot would throw on the
		// dimension mismatch; the dense leg must swallow it, not 500 the page.
		setMediaEmbedding(apple, 'a red apple', encodeVector([1]), MODEL);
		embedQueryMock.mockResolvedValue([1, 0]);

		const hits = await searchMediaForUser(u.id, 'apple');
		expect(hits.map((h) => h.id)).toEqual([apple]); // keyword result survives
	});

	it('ignores vectors from a superseded embedding model', async () => {
		resolveMock.mockReturnValue(CFG);
		const u = seedUser();
		// Embedded under an old model → excluded from the dense corpus, so a
		// no-keyword query finds nothing rather than surfacing it.
		addMedia(u.id, 'a golden retriever puppy', [1, 0], 'old-model');
		embedQueryMock.mockResolvedValue([1, 0]);

		expect(await searchMediaForUser(u.id, 'dog')).toEqual([]);
	});
});
