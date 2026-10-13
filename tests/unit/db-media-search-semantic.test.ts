import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB }));
vi.mock('#lib/server/db/client.js', () => ({
	getDb: () => mocks.testDb,
	closeDb: () => {},
}));

// The semantic leg pulls config + the query embedding from these; mock both so
// we control whether/what the dense leg ranks against (no real endpoint).
const resolveMock = vi.hoisted(() => vi.fn());
vi.mock('#lib/server/retrieval/embeddings-config.js', () => ({
	resolveRelevanceConfig: resolveMock,
}));
const embedQueryMock = vi.hoisted(() => vi.fn());
vi.mock('#lib/server/retrieval/embed-rank.js', () => ({ embedQuery: embedQueryMock }));

import {
	insertMedia,
	searchMediaForUser,
	setMediaEmbedding,
	trashMediaForUser,
} from '#lib/server/db/queries/media.js';
import { encodeVector } from '#lib/server/retrieval/vector.js';

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
	it('surfaces a synonym match the keyword leg misses, and floors out noise', async () => {
		resolveMock.mockReturnValue(CFG);
		const u = seedUser();
		const puppy = addMedia(u.id, 'a golden retriever puppy', [1, 0]);
		addMedia(u.id, 'a sunny meadow', [0, 1]);
		// "dog" shares no token with either prompt; it embeds onto the puppy
		// (cosine 1) and orthogonal to the meadow (cosine 0, below the floor).
		embedQueryMock.mockResolvedValue([1, 0]);

		const hits = await searchMediaForUser(u.id, 'dog');
		expect(hits.map((h) => h.id)).toEqual([puppy]); // synonym in, unrelated out
		expect(embedQueryMock).toHaveBeenCalledOnce();
	});

	it('keeps keyword matches when embeddings are configured', async () => {
		resolveMock.mockReturnValue(CFG);
		const u = seedUser();
		const apple = addMedia(u.id, 'a red apple', [1, 0]);
		addMedia(u.id, 'a blue car', [0, 1]);
		embedQueryMock.mockResolvedValue([1, 0]);

		const hits = await searchMediaForUser(u.id, 'apple');
		expect(hits.map((h) => h.id)).toEqual([apple]); // lexical hit; car floored out
	});

	it('respects the configurable cosine floor', async () => {
		const u = seedUser();
		// A moderate neighbour: cosine([1,0], [0.6,0.8]) = 0.6. No keyword overlap
		// with the query, so it surfaces only via the dense leg.
		const wolf = addMedia(u.id, 'a lone wolf in snow', [0.6, 0.8]);
		embedQueryMock.mockResolvedValue([1, 0]);

		resolveMock.mockReturnValue(CFG); // default floor 0.5 → 0.6 passes
		expect((await searchMediaForUser(u.id, 'canine')).map((h) => h.id)).toEqual([wolf]);

		resolveMock.mockReturnValue({ ...CFG, gallerySearchMinSimilarity: 0.7 }); // 0.6 < 0.7
		expect(await searchMediaForUser(u.id, 'canine')).toEqual([]);
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
	it('finds an item embedded after the corpus was cached', async () => {
		resolveMock.mockReturnValue(CFG);
		embedQueryMock.mockResolvedValue([1, 0]);
		const u = seedUser();
		addMedia(u.id, 'a sunny meadow', [0, 1]);
		expect(await searchMediaForUser(u.id, 'dog')).toEqual([]); // warms the cache
		const puppy = addMedia(u.id, 'a golden retriever puppy', [1, 0]);
		expect((await searchMediaForUser(u.id, 'dog')).map((h) => h.id)).toEqual([puppy]);
	});

	it('drops a trashed item from a cached corpus', async () => {
		resolveMock.mockReturnValue(CFG);
		embedQueryMock.mockResolvedValue([1, 0]);
		const u = seedUser();
		const puppy = addMedia(u.id, 'a golden retriever puppy', [1, 0]);
		expect((await searchMediaForUser(u.id, 'dog')).map((h) => h.id)).toEqual([puppy]);
		trashMediaForUser(puppy, u.id);
		expect(await searchMediaForUser(u.id, 'dog')).toEqual([]);
	});
});
