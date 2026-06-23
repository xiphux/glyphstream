import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB }));
vi.mock('$lib/server/db/client', () => ({
	getDb: () => mocks.testDb,
	closeDb: () => {},
}));

import {
	bulkHardDeleteMediaForUser,
	decrementMediaForMessages,
	findPurgeCandidates,
	getMediaForUser,
	hardDeleteMediaForUser,
	insertMedia,
	linkMessageMedia,
	listConversationMediaRefs,
	listDistinctSourceModelsForUser,
	listMediaMonthPeriodsForUser,
	listMediaNeedingEmbedding,
	searchMediaForUser,
	listConversationsForMedia,
	listMediaForConversation,
	listMediaForUser,
	listMessageIdsForConversation,
	stampOrphanedZeroRefRows,
} from '$lib/server/db/queries/media';
import {
	archiveConversation,
	createConversation,
	deleteConversation,
} from '$lib/server/db/queries/conversations';
import { appendMessage } from '$lib/server/db/queries/messages';
import { conversations, media } from '$lib/server/db/schema';

beforeEach(() => {
	mocks.testDb = createTestDb();
});

afterEach(() => {
	closeTestDb();
});

function makeMedia(userId: string, overrides: Partial<Parameters<typeof insertMedia>[0]> = {}) {
	return insertMedia({
		userId,
		storagePath: `ab/cd/${Math.random().toString(36).slice(2)}.png`,
		contentType: 'image/png',
		byteSize: 1024,
		kind: 'image',
		sourceEndpointId: 'bridge',
		sourceModel: 'comfyui/sdxl',
		promptExcerpt: 'a panda',
		...overrides,
	});
}

function getRow(mediaId: string) {
	return mocks.testDb.select().from(media).where(eq(media.id, mediaId)).get();
}

// insertMedia stamps createdAt = Date.now(); override it for deterministic
// time-ordering / period-bucketing assertions.
function setCreatedAt(mediaId: string, createdAt: number) {
	mocks.testDb.update(media).set({ createdAt }).where(eq(media.id, mediaId)).run();
}

describe('media: insert + ref counting', () => {
	it('insertMedia starts at refCount=0, unreferencedSince=null', () => {
		const u = seedUser();
		const { id } = makeMedia(u.id);
		const row = getRow(id);
		expect(row?.refCount).toBe(0);
		expect(row?.unreferencedSince).toBeNull();
		expect(row?.hardDeletedAt).toBeNull();
	});

	it('insertMedia defaults to origin=generated', () => {
		const u = seedUser();
		const { id } = makeMedia(u.id);
		expect(getRow(id)?.origin).toBe('generated');
	});

	it('insertMedia round-trips originalFilename on file-kind rows', () => {
		const u = seedUser();
		const { id } = makeMedia(u.id, {
			kind: 'file',
			contentType: 'text/csv',
			storagePath: 'ab/cd/test.csv',
			sourceModel: null,
			origin: 'uploaded',
			originalFilename: 'Q4-budget.csv',
		});
		expect(getRow(id)?.originalFilename).toBe('Q4-budget.csv');
	});

	it('insertMedia round-trips sourceMediaId (split / i2i provenance) and defaults it to null', () => {
		const u = seedUser();
		const input = makeMedia(u.id);
		expect(getRow(input.id)?.sourceMediaId).toBeNull();
		const edited = makeMedia(u.id, { sourceMediaId: input.id });
		expect(getRow(edited.id)?.sourceMediaId).toBe(input.id);
	});

	it('insertMedia defaults originalFilename to null when not supplied', () => {
		const u = seedUser();
		const { id } = makeMedia(u.id);
		// Legacy / generated rows don't have an original filename — null is
		// the documented sentinel that drives the chip's fallback label.
		expect(getRow(id)?.originalFilename).toBeNull();
	});

	it('uploaded origin starts purge-candidate (unreferencedSince=now)', () => {
		const u = seedUser();
		const before = Date.now();
		const { id } = makeMedia(u.id, { origin: 'uploaded' });
		const after = Date.now();
		const row = getRow(id);
		expect(row?.origin).toBe('uploaded');
		// Stamped on insert so an abandoned upload gets swept after grace.
		expect(row?.unreferencedSince).toBeGreaterThanOrEqual(before);
		expect(row?.unreferencedSince).toBeLessThanOrEqual(after);
	});

	it('linking an uploaded media to a message clears the purge stamp', () => {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::x',
			modelKind: 'chat',
		});
		const msg = appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'user',
			parts: [{ type: 'text', text: 'look at this' }],
		});
		const { id } = makeMedia(u.id, { origin: 'uploaded' });
		// Stamped at upload time.
		expect(getRow(id)?.unreferencedSince).not.toBeNull();
		linkMessageMedia(msg.id, id);
		// Stamp cleared once the upload is actually attached to a message.
		expect(getRow(id)?.refCount).toBe(1);
		expect(getRow(id)?.unreferencedSince).toBeNull();
	});

	it('linkMessageMedia bumps refCount and clears unreferencedSince', () => {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::x',
			modelKind: 'image',
		});
		const msg = appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'assistant',
			parts: [{ type: 'text', text: 'here it is' }],
		});
		const { id } = makeMedia(u.id);
		linkMessageMedia(msg.id, id);
		expect(getRow(id)?.refCount).toBe(1);
	});

	it('linkMessageMedia is idempotent (PK on (message_id, media_id))', () => {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::x',
			modelKind: 'image',
		});
		const msg = appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'assistant',
			parts: [{ type: 'text', text: 'x' }],
		});
		const { id } = makeMedia(u.id);
		linkMessageMedia(msg.id, id);
		linkMessageMedia(msg.id, id);
		// Second link is a no-op; refCount stays at 1.
		expect(getRow(id)?.refCount).toBe(1);
	});

	it('decrementMediaForMessages decrements per link + stamps unreferencedSince when count hits 0', () => {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::x',
			modelKind: 'image',
		});
		const msg1 = appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'user',
			parts: [{ type: 'text', text: 'a' }],
		});
		const msg2 = appendMessage({
			conversationId: conv.id,
			parentMessageId: msg1.id,
			role: 'assistant',
			parts: [{ type: 'text', text: 'b' }],
		});
		const { id } = makeMedia(u.id);
		linkMessageMedia(msg1.id, id);
		linkMessageMedia(msg2.id, id);
		expect(getRow(id)?.refCount).toBe(2);

		mocks.testDb.transaction((tx) => decrementMediaForMessages(tx, [msg1.id]));
		expect(getRow(id)?.refCount).toBe(1);
		expect(getRow(id)?.unreferencedSince).toBeNull();

		mocks.testDb.transaction((tx) => decrementMediaForMessages(tx, [msg2.id]));
		const row = getRow(id);
		expect(row?.refCount).toBe(0);
		// crossed zero — clock starts.
		expect(row?.unreferencedSince).not.toBeNull();
	});

	it('decrementMediaForMessages clamps refCount at 0 (defensive)', () => {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::x',
			modelKind: 'image',
		});
		const msg = appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'assistant',
			parts: [{ type: 'text', text: 'x' }],
		});
		const { id } = makeMedia(u.id);
		linkMessageMedia(msg.id, id);
		// Manually corrupt to refCount=0 to simulate inconsistency, then
		// decrement. Should clamp at 0, not go negative.
		mocks.testDb.update(media).set({ refCount: 0 }).where(eq(media.id, id)).run();
		mocks.testDb.transaction((tx) => decrementMediaForMessages(tx, [msg.id]));
		expect(getRow(id)?.refCount).toBe(0);
	});
});

describe('deleteConversation cascade decrements media refs', () => {
	it('drops ref counts for media referenced by deleted messages', () => {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::x',
			modelKind: 'image',
		});
		const msg = appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'assistant',
			parts: [{ type: 'text', text: 'x' }],
		});
		const { id } = makeMedia(u.id);
		linkMessageMedia(msg.id, id);
		expect(getRow(id)?.refCount).toBe(1);

		deleteConversation(conv.id, u.id);

		// Media row survives (so historical /api/media/:id requests don't 500),
		// but the count is decremented and the purge clock starts.
		const row = getRow(id);
		expect(row).toBeTruthy();
		expect(row?.refCount).toBe(0);
		expect(row?.unreferencedSince).not.toBeNull();
	});
});

describe('listMediaForUser', () => {
	it('returns user-owned, non-deleted media newest-first', async () => {
		const u = seedUser();
		const m1 = makeMedia(u.id);
		await new Promise((r) => setTimeout(r, 5));
		const m2 = makeMedia(u.id);
		const page = listMediaForUser(u.id);
		expect(page.items.map((i) => i.id)).toEqual([m2.id, m1.id]);
	});

	it('filters out hard-deleted rows', () => {
		const u = seedUser();
		const m1 = makeMedia(u.id);
		makeMedia(u.id);
		hardDeleteMediaForUser(m1.id, u.id);
		const page = listMediaForUser(u.id);
		expect(page.items.map((i) => i.id)).not.toContain(m1.id);
	});

	it('filters by kind when provided', () => {
		const u = seedUser();
		const img = makeMedia(u.id, { kind: 'image' });
		const vid = makeMedia(u.id, { kind: 'video', contentType: 'video/mp4' });
		expect(listMediaForUser(u.id, { kind: 'image' }).items.map((i) => i.id)).toEqual([img.id]);
		expect(listMediaForUser(u.id, { kind: 'video' }).items.map((i) => i.id)).toEqual([vid.id]);
	});

	it('returns nextCursor when there are more pages', () => {
		const u = seedUser();
		for (let i = 0; i < 5; i++) makeMedia(u.id);
		const page = listMediaForUser(u.id, { limit: 3 });
		expect(page.items).toHaveLength(3);
		expect(page.nextCursor).not.toBeNull();
	});

	it('cursor pagination yields the rest', () => {
		const u = seedUser();
		for (let i = 0; i < 5; i++) makeMedia(u.id);
		const p1 = listMediaForUser(u.id, { limit: 3 });
		const p2 = listMediaForUser(u.id, { limit: 3, cursor: p1.nextCursor });
		expect(p2.items).toHaveLength(2);
		expect(p2.nextCursor).toBeNull();
		// No overlap between pages.
		const ids1 = new Set(p1.items.map((i) => i.id));
		for (const item of p2.items) expect(ids1.has(item.id)).toBe(false);
	});

	it('does not leak across users', () => {
		const u1 = seedUser();
		const u2 = seedUser();
		makeMedia(u1.id);
		expect(listMediaForUser(u2.id).items).toEqual([]);
	});

	it('hides uploaded media — gallery is "what the AI made"', () => {
		const u = seedUser();
		makeMedia(u.id, { origin: 'generated' });
		makeMedia(u.id, { origin: 'uploaded' });
		const list = listMediaForUser(u.id);
		expect(list.items).toHaveLength(1);
	});

	// File-kind rows are AI-generated artifacts (e.g. code interpreter
	// outputs) or user uploads (xlsx/pdf/...). Neither belongs in the
	// gallery UI — that's for visual library content. The default
	// kind filter on listMediaForUser is the load-bearing piece that
	// keeps them out across every gallery caller.
	it('default kinds filter excludes kind: "file" — never leaks into gallery', () => {
		const u = seedUser();
		const img = makeMedia(u.id, { kind: 'image' });
		const vid = makeMedia(u.id, { kind: 'video', contentType: 'video/mp4' });
		makeMedia(u.id, {
			kind: 'file',
			contentType: 'text/csv',
			sourceModel: 'run_python',
		});
		const list = listMediaForUser(u.id);
		const ids = list.items.map((i) => i.id).sort();
		expect(ids).toEqual([img.id, vid.id].sort());
	});

	it('opts.kinds opt-in surfaces file rows for callers that want the full set', () => {
		const u = seedUser();
		const img = makeMedia(u.id, { kind: 'image' });
		const file = makeMedia(u.id, {
			kind: 'file',
			contentType: 'text/csv',
			sourceModel: 'run_python',
		});
		const list = listMediaForUser(u.id, { kinds: ['image', 'video', 'file'] });
		const ids = list.items.map((i) => i.id).sort();
		expect(ids).toEqual([img.id, file.id].sort());
	});

	it('opts.kinds with a single kind narrows correctly', () => {
		const u = seedUser();
		makeMedia(u.id, { kind: 'image' });
		const file = makeMedia(u.id, {
			kind: 'file',
			contentType: 'application/pdf',
			sourceModel: 'run_python',
		});
		const list = listMediaForUser(u.id, { kinds: ['file'] });
		expect(list.items.map((i) => i.id)).toEqual([file.id]);
	});

	it('filters by model (source_model) when provided', () => {
		const u = seedUser();
		const a = makeMedia(u.id, { sourceModel: 'comfyui/sdxl' });
		makeMedia(u.id, { sourceModel: 'comfyui/flux' });
		const list = listMediaForUser(u.id, { model: 'comfyui/sdxl' });
		expect(list.items.map((i) => i.id)).toEqual([a.id]);
	});

	it('model + kind AND together', () => {
		const u = seedUser();
		const sdxlImg = makeMedia(u.id, { kind: 'image', sourceModel: 'comfyui/sdxl' });
		makeMedia(u.id, { kind: 'video', contentType: 'video/mp4', sourceModel: 'comfyui/sdxl' });
		makeMedia(u.id, { kind: 'image', sourceModel: 'comfyui/flux' });
		const list = listMediaForUser(u.id, { kind: 'image', model: 'comfyui/sdxl' });
		expect(list.items.map((i) => i.id)).toEqual([sdxlImg.id]);
	});

	it('absent model is unchanged (returns all)', () => {
		const u = seedUser();
		makeMedia(u.id, { sourceModel: 'comfyui/sdxl' });
		makeMedia(u.id, { sourceModel: 'comfyui/flux' });
		expect(listMediaForUser(u.id).items).toHaveLength(2);
	});

	it('before seeks to rows strictly older than the anchor', () => {
		const u = seedUser();
		const older = makeMedia(u.id);
		const newer = makeMedia(u.id);
		setCreatedAt(older.id, 1000);
		setCreatedAt(newer.id, 2000);
		expect(listMediaForUser(u.id, { before: 2000 }).items.map((i) => i.id)).toEqual([older.id]);
		expect(listMediaForUser(u.id, { before: 3000 }).items.map((i) => i.id)).toEqual([
			newer.id,
			older.id,
		]);
	});

	it('before composes with model', () => {
		const u = seedUser();
		const a = makeMedia(u.id, { sourceModel: 'comfyui/sdxl' });
		const b = makeMedia(u.id, { sourceModel: 'comfyui/flux' });
		setCreatedAt(a.id, 1000);
		setCreatedAt(b.id, 1500);
		expect(
			listMediaForUser(u.id, { before: 2000, model: 'comfyui/sdxl' }).items.map((i) => i.id),
		).toEqual([a.id]);
	});
});

describe('listMediaMonthPeriodsForUser (quick-jump timeline)', () => {
	// June 1 2026 00:30 UTC — straddles the May/June boundary under a negative
	// (west-of-UTC) offset, so we can prove local-time bucketing.
	const juneBoundaryUtc = Date.UTC(2026, 5, 1, 0, 30);
	const midJuneUtc = Date.UTC(2026, 5, 15, 12);
	const midMayUtc = Date.UTC(2026, 4, 15, 12);

	it('returns months with counts, newest-first (UTC buckets at offset 0)', () => {
		const u = seedUser();
		const a = makeMedia(u.id);
		const b = makeMedia(u.id);
		const c = makeMedia(u.id);
		setCreatedAt(a.id, midJuneUtc);
		setCreatedAt(b.id, midJuneUtc + 1000);
		setCreatedAt(c.id, midMayUtc);
		expect(listMediaMonthPeriodsForUser(u.id, { tzOffsetMinutes: 0 })).toEqual([
			{ key: '2026-06', count: 2 },
			{ key: '2026-05', count: 1 },
		]);
	});

	it('buckets in local time per tzOffsetMinutes', () => {
		const u = seedUser();
		const m = makeMedia(u.id);
		setCreatedAt(m.id, juneBoundaryUtc);
		// UTC → June; shifted back 2h → May 31 22:30 local → May.
		expect(listMediaMonthPeriodsForUser(u.id, { tzOffsetMinutes: 0 })).toEqual([
			{ key: '2026-06', count: 1 },
		]);
		expect(listMediaMonthPeriodsForUser(u.id, { tzOffsetMinutes: -120 })).toEqual([
			{ key: '2026-05', count: 1 },
		]);
	});

	it('excludes uploaded, file-kind, and hard-deleted rows', () => {
		const u = seedUser();
		const keep = makeMedia(u.id);
		setCreatedAt(keep.id, midJuneUtc);
		makeMedia(u.id, { origin: 'uploaded' });
		makeMedia(u.id, { kind: 'file', contentType: 'text/csv', sourceModel: 'run_python' });
		const del = makeMedia(u.id);
		setCreatedAt(del.id, midMayUtc);
		hardDeleteMediaForUser(del.id, u.id);
		expect(listMediaMonthPeriodsForUser(u.id, { tzOffsetMinutes: 0 })).toEqual([
			{ key: '2026-06', count: 1 },
		]);
	});

	it('respects kind and model filters', () => {
		const u = seedUser();
		const img = makeMedia(u.id, { kind: 'image', sourceModel: 'comfyui/sdxl' });
		const vid = makeMedia(u.id, {
			kind: 'video',
			contentType: 'video/mp4',
			sourceModel: 'comfyui/svd',
		});
		setCreatedAt(img.id, midJuneUtc);
		setCreatedAt(vid.id, midJuneUtc);
		expect(listMediaMonthPeriodsForUser(u.id, { tzOffsetMinutes: 0, kind: 'video' })).toEqual([
			{ key: '2026-06', count: 1 },
		]);
		expect(
			listMediaMonthPeriodsForUser(u.id, { tzOffsetMinutes: 0, model: 'comfyui/sdxl' }),
		).toEqual([{ key: '2026-06', count: 1 }]);
	});

	it('does not leak across users', () => {
		const u1 = seedUser();
		const u2 = seedUser();
		const m = makeMedia(u1.id);
		setCreatedAt(m.id, midJuneUtc);
		expect(listMediaMonthPeriodsForUser(u2.id, { tzOffsetMinutes: 0 })).toEqual([]);
	});
});

describe('searchMediaForUser (keyword prompt search)', () => {
	// No [embeddings] block in the unit env → resolveRelevanceConfig() is
	// undefined, so these exercise the keyword-only (FTS bm25) path.
	it('matches prompt tokens and excludes non-matches', async () => {
		const u = seedUser();
		const sunset = makeMedia(u.id, { promptFull: 'a sunset over the ocean' });
		makeMedia(u.id, { promptFull: 'a fluffy cat on a sofa' });
		const hits = await searchMediaForUser(u.id, 'sunset');
		expect(hits.map((h) => h.id)).toEqual([sunset.id]);
	});

	it('empty / whitespace query returns nothing', async () => {
		const u = seedUser();
		makeMedia(u.id, { promptFull: 'anything' });
		expect(await searchMediaForUser(u.id, '   ')).toEqual([]);
	});

	it('ranks higher term frequency first (bm25)', async () => {
		const u = seedUser();
		const once = makeMedia(u.id, { promptFull: 'blue sky' });
		const twice = makeMedia(u.id, { promptFull: 'blue blue ocean' });
		const hits = await searchMediaForUser(u.id, 'blue');
		expect(hits.map((h) => h.id)).toContain(once.id);
		expect(hits[0].id).toBe(twice.id); // more "blue" → better bm25
	});

	it('AND-joins multiple tokens (all must be present)', async () => {
		const u = seedUser();
		const both = makeMedia(u.id, { promptFull: 'a red barn in a field' });
		makeMedia(u.id, { promptFull: 'a red car' });
		expect((await searchMediaForUser(u.id, 'red barn')).map((h) => h.id)).toEqual([both.id]);
	});

	it('composes with kind and model filters', async () => {
		const u = seedUser();
		const img = makeMedia(u.id, {
			kind: 'image',
			sourceModel: 'comfyui/sdxl',
			promptFull: 'a dragon',
		});
		makeMedia(u.id, {
			kind: 'video',
			contentType: 'video/mp4',
			sourceModel: 'comfyui/svd',
			promptFull: 'a dragon',
		});
		expect((await searchMediaForUser(u.id, 'dragon', { kind: 'image' })).map((h) => h.id)).toEqual([
			img.id,
		]);
		expect(
			(await searchMediaForUser(u.id, 'dragon', { model: 'comfyui/sdxl' })).map((h) => h.id),
		).toEqual([img.id]);
	});

	it('excludes uploaded and hard-deleted rows', async () => {
		const u = seedUser();
		const keep = makeMedia(u.id, { promptFull: 'a castle' });
		makeMedia(u.id, { origin: 'uploaded', promptFull: 'a castle' });
		const del = makeMedia(u.id, { promptFull: 'a castle' });
		hardDeleteMediaForUser(del.id, u.id);
		expect((await searchMediaForUser(u.id, 'castle')).map((h) => h.id)).toEqual([keep.id]);
	});

	it('reflects prompt_full updates (trigger keeps the index in sync)', async () => {
		const u = seedUser();
		const m = makeMedia(u.id, { promptFull: 'original mountains' });
		expect((await searchMediaForUser(u.id, 'mountains')).map((h) => h.id)).toEqual([m.id]);
		mocks.testDb
			.update(media)
			.set({ promptFull: 'replaced deserts' })
			.where(eq(media.id, m.id))
			.run();
		expect(await searchMediaForUser(u.id, 'mountains')).toEqual([]);
		expect((await searchMediaForUser(u.id, 'deserts')).map((h) => h.id)).toEqual([m.id]);
	});

	it('does not leak across users', async () => {
		const u1 = seedUser();
		const u2 = seedUser();
		makeMedia(u1.id, { promptFull: 'a secret garden' });
		expect(await searchMediaForUser(u2.id, 'garden')).toEqual([]);
	});

	it('honours the limit cap', async () => {
		const u = seedUser();
		for (let i = 0; i < 5; i++) makeMedia(u.id, { promptFull: `a tower number ${i}` });
		expect(await searchMediaForUser(u.id, 'tower', { limit: 3 })).toHaveLength(3);
	});
});

describe('listMediaNeedingEmbedding (backfill queue)', () => {
	it('queues generated, prompted, un-embedded rows; skips uploads + null-prompt', () => {
		const u = seedUser();
		const want = makeMedia(u.id, { promptFull: 'a prompt' });
		makeMedia(u.id, { promptFull: null }); // no prompt to embed
		makeMedia(u.id, { origin: 'uploaded', promptFull: 'an upload' });
		const ids = listMediaNeedingEmbedding('embed-v1', 100).map((r) => r.id);
		expect(ids).toEqual([want.id]);
	});

	it('excludes hard-deleted media (no embed call spent on a tombstone)', () => {
		const u = seedUser();
		const keep = makeMedia(u.id, { promptFull: 'a keeper' });
		const del = makeMedia(u.id, { promptFull: 'a goner' });
		hardDeleteMediaForUser(del.id, u.id);
		const ids = listMediaNeedingEmbedding('embed-v1', 100).map((r) => r.id);
		expect(ids).toContain(keep.id);
		expect(ids).not.toContain(del.id);
	});
});

describe('listDistinctSourceModelsForUser (model facet)', () => {
	it('returns distinct models with counts, most-used first', () => {
		const u = seedUser();
		makeMedia(u.id, { sourceModel: 'comfyui/sdxl' });
		makeMedia(u.id, { sourceModel: 'comfyui/sdxl' });
		makeMedia(u.id, { sourceModel: 'comfyui/flux' });
		const facets = listDistinctSourceModelsForUser(u.id);
		expect(facets).toEqual([
			{ value: 'comfyui/sdxl', count: 2 },
			{ value: 'comfyui/flux', count: 1 },
		]);
	});

	it('excludes uploaded, hard-deleted, file-kind, and null-model rows', () => {
		const u = seedUser();
		makeMedia(u.id, { sourceModel: 'comfyui/sdxl' });
		makeMedia(u.id, { origin: 'uploaded', sourceModel: 'comfyui/sdxl' });
		makeMedia(u.id, { kind: 'file', contentType: 'text/csv', sourceModel: 'run_python' });
		makeMedia(u.id, { sourceModel: null });
		const del = makeMedia(u.id, { sourceModel: 'comfyui/flux' });
		hardDeleteMediaForUser(del.id, u.id);
		const facets = listDistinctSourceModelsForUser(u.id);
		expect(facets).toEqual([{ value: 'comfyui/sdxl', count: 1 }]);
	});

	it('respects the kind option', () => {
		const u = seedUser();
		makeMedia(u.id, { kind: 'image', sourceModel: 'comfyui/sdxl' });
		makeMedia(u.id, { kind: 'video', contentType: 'video/mp4', sourceModel: 'comfyui/svd' });
		expect(listDistinctSourceModelsForUser(u.id, { kind: 'video' })).toEqual([
			{ value: 'comfyui/svd', count: 1 },
		]);
	});

	it('does not leak across users', () => {
		const u1 = seedUser();
		const u2 = seedUser();
		makeMedia(u1.id, { sourceModel: 'comfyui/sdxl' });
		expect(listDistinctSourceModelsForUser(u2.id)).toEqual([]);
	});
});

describe('listMediaForUser conversation assignment (gallery stacking)', () => {
	function makeConv(userId: string, title: string | null = null) {
		const conv = createConversation({
			userId,
			endpointId: 'bridge',
			modelId: 'bridge::x',
			modelKind: 'image',
		});
		if (title !== null) {
			mocks.testDb.update(conversations).set({ title }).where(eq(conversations.id, conv.id)).run();
		}
		return conv;
	}

	function makeMsg(conversationId: string) {
		return appendMessage({
			conversationId,
			parentMessageId: null,
			role: 'assistant',
			parts: [{ type: 'text', text: 'x' }],
		});
	}

	it('assigns conversationId + title from the referencing message', () => {
		const u = seedUser();
		const conv = makeConv(u.id, 'Logo ideas');
		const msg = makeMsg(conv.id);
		const { id } = makeMedia(u.id);
		linkMessageMedia(msg.id, id);

		const item = listMediaForUser(u.id).items.find((i) => i.id === id)!;
		expect(item.conversationId).toBe(conv.id);
		expect(item.conversationTitle).toBe('Logo ideas');
	});

	it('leaves conversationId + title null for orphan media (no join rows)', () => {
		const u = seedUser();
		const { id } = makeMedia(u.id);
		const item = listMediaForUser(u.id).items.find((i) => i.id === id)!;
		expect(item.conversationId).toBeNull();
		expect(item.conversationTitle).toBeNull();
	});

	it('null title surfaces as null (untitled conversation)', () => {
		const u = seedUser();
		const conv = makeConv(u.id, null);
		const msg = makeMsg(conv.id);
		const { id } = makeMedia(u.id);
		linkMessageMedia(msg.id, id);
		const item = listMediaForUser(u.id).items.find((i) => i.id === id)!;
		expect(item.conversationId).toBe(conv.id);
		expect(item.conversationTitle).toBeNull();
	});

	it('picks the earliest referencing message when media spans conversations', async () => {
		const u = seedUser();
		const convA = makeConv(u.id, 'first');
		const msgA = makeMsg(convA.id);
		await new Promise((r) => setTimeout(r, 5));
		const convB = makeConv(u.id, 'second');
		const msgB = makeMsg(convB.id);
		const { id } = makeMedia(u.id);
		// Reused across two conversations; the earlier message's conversation wins.
		linkMessageMedia(msgB.id, id);
		linkMessageMedia(msgA.id, id);

		const item = listMediaForUser(u.id).items.find((i) => i.id === id)!;
		expect(item.conversationId).toBe(convA.id);
		expect(item.conversationTitle).toBe('first');
	});
});

describe('listMediaForConversation (drill-in stack contents)', () => {
	function makeConv(userId: string, title: string | null = null) {
		const conv = createConversation({
			userId,
			endpointId: 'bridge',
			modelId: 'bridge::x',
			modelKind: 'image',
		});
		if (title !== null) {
			mocks.testDb.update(conversations).set({ title }).where(eq(conversations.id, conv.id)).run();
		}
		return conv;
	}
	function makeMsg(conversationId: string) {
		return appendMessage({
			conversationId,
			parentMessageId: null,
			role: 'assistant',
			parts: [{ type: 'text', text: 'x' }],
		});
	}

	it('returns all media assigned to a conversation, newest-first, with title', async () => {
		const u = seedUser();
		const conv = makeConv(u.id, 'Logo ideas');
		const msg = makeMsg(conv.id);
		const a = makeMedia(u.id);
		await new Promise((r) => setTimeout(r, 5));
		const b = makeMedia(u.id);
		linkMessageMedia(msg.id, a.id);
		linkMessageMedia(msg.id, b.id);

		const items = listMediaForConversation(conv.id, u.id);
		expect(items.map((i) => i.id)).toEqual([b.id, a.id]); // newest first
		expect(items.every((i) => i.conversationId === conv.id)).toBe(true);
		expect(items[0].conversationTitle).toBe('Logo ideas');
	});

	it('excludes media whose assigned (earliest) conversation is a different one', async () => {
		const u = seedUser();
		const convA = makeConv(u.id);
		const msgA = makeMsg(convA.id);
		await new Promise((r) => setTimeout(r, 5));
		const convB = makeConv(u.id);
		const msgB = makeMsg(convB.id);
		const { id } = makeMedia(u.id);
		// Reused across both; assigned to convA (earliest message).
		linkMessageMedia(msgA.id, id);
		linkMessageMedia(msgB.id, id);

		// Belongs to convA's stack only — must not double-count under convB.
		expect(listMediaForConversation(convA.id, u.id).map((i) => i.id)).toEqual([id]);
		expect(listMediaForConversation(convB.id, u.id)).toEqual([]);
	});

	it('respects the kind filter', () => {
		const u = seedUser();
		const conv = makeConv(u.id);
		const msg = makeMsg(conv.id);
		const img = makeMedia(u.id, { kind: 'image' });
		const vid = makeMedia(u.id, { kind: 'video', contentType: 'video/mp4' });
		linkMessageMedia(msg.id, img.id);
		linkMessageMedia(msg.id, vid.id);

		expect(listMediaForConversation(conv.id, u.id, { kind: 'video' }).map((i) => i.id)).toEqual([
			vid.id,
		]);
	});

	it('respects the model filter (drill-in stays consistent with an active facet)', () => {
		const u = seedUser();
		const conv = makeConv(u.id);
		const msg = makeMsg(conv.id);
		const sdxl = makeMedia(u.id, { sourceModel: 'comfyui/sdxl' });
		const flux = makeMedia(u.id, { sourceModel: 'comfyui/flux' });
		linkMessageMedia(msg.id, sdxl.id);
		linkMessageMedia(msg.id, flux.id);

		expect(
			listMediaForConversation(conv.id, u.id, { model: 'comfyui/sdxl' }).map((i) => i.id),
		).toEqual([sdxl.id]);
	});

	it('excludes hard-deleted and uploaded media', () => {
		const u = seedUser();
		const conv = makeConv(u.id);
		const msg = makeMsg(conv.id);
		const live = makeMedia(u.id);
		const gone = makeMedia(u.id);
		const upload = makeMedia(u.id, { origin: 'uploaded' });
		linkMessageMedia(msg.id, live.id);
		linkMessageMedia(msg.id, gone.id);
		linkMessageMedia(msg.id, upload.id);
		hardDeleteMediaForUser(gone.id, u.id);

		expect(listMediaForConversation(conv.id, u.id).map((i) => i.id)).toEqual([live.id]);
	});

	it('returns [] for a foreign user', () => {
		const owner = seedUser();
		const intruder = seedUser();
		const conv = makeConv(owner.id);
		const msg = makeMsg(conv.id);
		const { id } = makeMedia(owner.id);
		linkMessageMedia(msg.id, id);
		expect(listMediaForConversation(conv.id, intruder.id)).toEqual([]);
	});
});

describe('hardDeleteMediaForUser', () => {
	it('marks the row hard-deleted + returns the storagePath for unlinking', () => {
		const u = seedUser();
		const { id } = makeMedia(u.id);
		const r = hardDeleteMediaForUser(id, u.id);
		expect(r?.storagePath).toMatch(/\.png$/);
		const row = getRow(id);
		expect(row?.hardDeletedAt).not.toBeNull();
		expect(row?.refCount).toBe(0);
	});

	it('returns null on cross-user hard-delete attempt', () => {
		const u1 = seedUser();
		const u2 = seedUser();
		const { id } = makeMedia(u1.id);
		expect(hardDeleteMediaForUser(id, u2.id)).toBeNull();
		// Original owner's row is untouched.
		expect(getRow(id)?.hardDeletedAt).toBeNull();
	});

	it('returns null on already-deleted (idempotent caller can ignore)', () => {
		const u = seedUser();
		const { id } = makeMedia(u.id);
		hardDeleteMediaForUser(id, u.id);
		expect(hardDeleteMediaForUser(id, u.id)).toBeNull();
	});

	it('drops message_media join rows so messages no longer link to it', () => {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::x',
			modelKind: 'image',
		});
		const msg = appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'assistant',
			parts: [{ type: 'text', text: 'x' }],
		});
		const { id } = makeMedia(u.id);
		linkMessageMedia(msg.id, id);
		hardDeleteMediaForUser(id, u.id);
		// Re-linking afterward should not re-bump refCount because it's
		// already at 0 (we cleared it).
		expect(getRow(id)?.refCount).toBe(0);
	});
});

describe('bulkHardDeleteMediaForUser', () => {
	it('returns [] for an empty input', () => {
		const u = seedUser();
		expect(bulkHardDeleteMediaForUser([], u.id)).toEqual([]);
	});

	it('tombstones every live row in the selection + returns their storagePaths', () => {
		const u = seedUser();
		const a = makeMedia(u.id);
		const b = makeMedia(u.id);
		const c = makeMedia(u.id);
		const result = bulkHardDeleteMediaForUser([a.id, b.id, c.id], u.id);
		expect(result).toHaveLength(3);
		const returnedIds = new Set(result.map((r) => r.id));
		expect(returnedIds).toEqual(new Set([a.id, b.id, c.id]));
		for (const r of result) {
			expect(r.storagePath).toMatch(/\.png$/);
		}
		for (const id of [a.id, b.id, c.id]) {
			const row = getRow(id);
			expect(row?.hardDeletedAt).not.toBeNull();
			expect(row?.refCount).toBe(0);
		}
	});

	it('skips already-deleted rows without poisoning the rest of the batch', () => {
		const u = seedUser();
		const a = makeMedia(u.id);
		const b = makeMedia(u.id);
		hardDeleteMediaForUser(a.id, u.id);
		const result = bulkHardDeleteMediaForUser([a.id, b.id], u.id);
		// Only b should be in the result — a was already a tombstone.
		expect(result.map((r) => r.id)).toEqual([b.id]);
		expect(getRow(b.id)?.hardDeletedAt).not.toBeNull();
	});

	it('skips foreign-owned ids — no cross-user delete leak', () => {
		const u1 = seedUser();
		const u2 = seedUser();
		const own = makeMedia(u1.id);
		const foreign = makeMedia(u2.id);
		const result = bulkHardDeleteMediaForUser([own.id, foreign.id], u1.id);
		expect(result.map((r) => r.id)).toEqual([own.id]);
		// u2's row is untouched.
		expect(getRow(foreign.id)?.hardDeletedAt).toBeNull();
	});

	it('drops message_media join rows for the deleted set', () => {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::x',
			modelKind: 'image',
		});
		const msg = appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'assistant',
			parts: [{ type: 'text', text: 'x' }],
		});
		const a = makeMedia(u.id);
		const b = makeMedia(u.id);
		linkMessageMedia(msg.id, a.id);
		linkMessageMedia(msg.id, b.id);
		bulkHardDeleteMediaForUser([a.id, b.id], u.id);
		// Both rows' join entries are gone (the listConversationsForMedia
		// lookup is empty for each).
		expect(listConversationsForMedia(a.id, u.id)).toEqual([]);
		expect(listConversationsForMedia(b.id, u.id)).toEqual([]);
	});
});

describe('purger sweep queries', () => {
	// Library-model scope: the purger only sweeps `origin='uploaded'`.
	// Generated media persists indefinitely and is removed only by
	// explicit user actions (gallery delete, conversation-delete
	// checkbox, branch-delete). Tests below seed `origin: 'uploaded'`
	// explicitly to exercise the actual sweep path.

	it('findPurgeCandidates returns uploaded rows past the cutoff, oldest first', () => {
		const u = seedUser();
		const { id: a } = makeMedia(u.id, { origin: 'uploaded' });
		const { id: b } = makeMedia(u.id, { origin: 'uploaded' });
		// Stamp both unreferenced; a is older.
		mocks.testDb.update(media).set({ unreferencedSince: 1000 }).where(eq(media.id, a)).run();
		mocks.testDb.update(media).set({ unreferencedSince: 2000 }).where(eq(media.id, b)).run();

		// Cutoff at 3000 (anything stamped at <= 3000 is past grace).
		const candidates = findPurgeCandidates(3000);
		expect(candidates.map((c) => c.id)).toEqual([a, b]);
	});

	it('findPurgeCandidates excludes generated rows even when otherwise eligible', () => {
		const u = seedUser();
		// Same shape as the upload candidate test, but origin='generated'.
		const { id } = makeMedia(u.id); // defaults to generated
		mocks.testDb.update(media).set({ unreferencedSince: 1000 }).where(eq(media.id, id)).run();
		expect(findPurgeCandidates(9999)).toEqual([]);
	});

	it('findPurgeCandidates excludes already-hard-deleted rows', () => {
		const u = seedUser();
		const { id } = makeMedia(u.id, { origin: 'uploaded' });
		mocks.testDb
			.update(media)
			.set({ unreferencedSince: 1000, hardDeletedAt: 1500 })
			.where(eq(media.id, id))
			.run();
		expect(findPurgeCandidates(9999)).toEqual([]);
	});

	it('findPurgeCandidates excludes rows with unreferencedSince=null', () => {
		const u = seedUser();
		makeMedia(u.id, { origin: 'uploaded' }); // refCount=0 but unreferencedSince=null
		expect(findPurgeCandidates(9999)).toEqual([]);
	});

	it('stampOrphanedZeroRefRows stamps zero-ref uploaded rows whose stamp is missing', () => {
		const u = seedUser();
		const { id } = makeMedia(u.id, { origin: 'uploaded' });
		// Ref count is 0 by default, unreferencedSince is null — qualifies.
		// But wait — insertMedia stamps `unreferenced_since = now` on uploads
		// at insert time, so this row is already stamped. Re-clear it to
		// exercise the crash-recovery path the stamp query is meant for.
		mocks.testDb.update(media).set({ unreferencedSince: null }).where(eq(media.id, id)).run();

		const stamped = stampOrphanedZeroRefRows();
		expect(stamped).toBeGreaterThanOrEqual(1);
		expect(getRow(id)?.unreferencedSince).not.toBeNull();
	});

	it('stampOrphanedZeroRefRows skips generated rows even when zero-ref', () => {
		const u = seedUser();
		// Generated media that's zero-ref + unstamped (e.g. crash between
		// insertMedia and linkMessageMedia) should NOT be stamped under the
		// library model — the row persists indefinitely, gallery delete is
		// the only way to remove it.
		const { id } = makeMedia(u.id); // defaults to generated
		stampOrphanedZeroRefRows();
		expect(getRow(id)?.unreferencedSince).toBeNull();
	});

	it('stampOrphanedZeroRefRows skips rows with refCount > 0', () => {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::x',
			modelKind: 'image',
		});
		const msg = appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'assistant',
			parts: [{ type: 'text', text: 'x' }],
		});
		const { id } = makeMedia(u.id, { origin: 'uploaded' });
		linkMessageMedia(msg.id, id);
		// refCount=1 now — should not be stamped.
		stampOrphanedZeroRefRows();
		expect(getRow(id)?.unreferencedSince).toBeNull();
	});
});

describe('listMessageIdsForConversation', () => {
	it('returns all message ids for a conversation, scoped correctly', () => {
		const u = seedUser();
		const conv1 = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::x',
			modelKind: 'chat',
		});
		const conv2 = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::y',
			modelKind: 'chat',
		});
		const m1 = appendMessage({
			conversationId: conv1.id,
			parentMessageId: null,
			role: 'user',
			parts: [{ type: 'text', text: '1' }],
		});
		const m2 = appendMessage({
			conversationId: conv1.id,
			parentMessageId: m1.id,
			role: 'assistant',
			parts: [{ type: 'text', text: '2' }],
		});
		appendMessage({
			conversationId: conv2.id,
			parentMessageId: null,
			role: 'user',
			parts: [{ type: 'text', text: '3' }],
		});

		const ids = listMessageIdsForConversation(conv1.id);
		expect(ids.sort()).toEqual([m1.id, m2.id].sort());
	});
});

describe('getMediaForUser ownership', () => {
	it('returns the row for the owner', () => {
		const u = seedUser();
		const { id } = makeMedia(u.id);
		expect(getMediaForUser(id, u.id)?.id).toBe(id);
	});

	it('returns null for cross-user lookup', () => {
		const u1 = seedUser();
		const u2 = seedUser();
		const { id } = makeMedia(u1.id);
		expect(getMediaForUser(id, u2.id)).toBeNull();
	});
});

describe('listConversationsForMedia', () => {
	function makeConv(userId: string, kind: 'chat' | 'image' = 'image') {
		return createConversation({
			userId,
			endpointId: 'bridge',
			modelId: 'bridge::x',
			modelKind: kind,
		});
	}

	function makeMsg(conversationId: string, role: 'user' | 'assistant' = 'assistant') {
		return appendMessage({
			conversationId,
			parentMessageId: null,
			role,
			parts: [{ type: 'text', text: 'placeholder' }],
		});
	}

	it('returns [] for media that no message references', () => {
		const u = seedUser();
		const { id } = makeMedia(u.id);
		expect(listConversationsForMedia(id, u.id)).toEqual([]);
	});

	it('returns [] for a foreign user even when refs exist', () => {
		const owner = seedUser();
		const intruder = seedUser();
		const conv = makeConv(owner.id);
		const msg = makeMsg(conv.id);
		const { id: mediaId } = makeMedia(owner.id);
		linkMessageMedia(msg.id, mediaId);

		expect(listConversationsForMedia(mediaId, intruder.id)).toEqual([]);
	});

	it('returns the single conversation that references this media', () => {
		const u = seedUser();
		const conv = makeConv(u.id);
		const msg = makeMsg(conv.id);
		const { id: mediaId } = makeMedia(u.id);
		linkMessageMedia(msg.id, mediaId);

		const result = listConversationsForMedia(mediaId, u.id);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({ id: conv.id, archivedAt: null });
	});

	it('dedupes when multiple messages in the same conversation reference the media', () => {
		const u = seedUser();
		const conv = makeConv(u.id);
		const msg1 = makeMsg(conv.id);
		const msg2 = makeMsg(conv.id);
		const { id: mediaId } = makeMedia(u.id);
		linkMessageMedia(msg1.id, mediaId);
		linkMessageMedia(msg2.id, mediaId);

		// DISTINCT collapses the two messages → one conversation row.
		const result = listConversationsForMedia(mediaId, u.id);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe(conv.id);
	});

	it('returns multiple conversations newest first', async () => {
		const u = seedUser();
		const convA = makeConv(u.id);
		// Sleep 2ms between writes so updated_at strictly increases. The
		// initial create gap isn't enough on its own — appendMessage bumps
		// updated_at to the message's createdAt, so without a gap between
		// the two appendMessage calls below convA and convB end up with
		// identical updated_at values and the newest-first sort tie-breaks
		// non-deterministically (which plan SQLite picks affects the order).
		await new Promise((r) => setTimeout(r, 2));
		const convB = makeConv(u.id);
		const msgA = makeMsg(convA.id);
		await new Promise((r) => setTimeout(r, 2));
		const msgB = makeMsg(convB.id);
		const { id: mediaId } = makeMedia(u.id);
		linkMessageMedia(msgA.id, mediaId);
		linkMessageMedia(msgB.id, mediaId);

		const result = listConversationsForMedia(mediaId, u.id);
		expect(result.map((c) => c.id)).toEqual([convB.id, convA.id]);
	});

	it('includes archived conversations with archivedAt populated', () => {
		const u = seedUser();
		const conv = makeConv(u.id);
		const msg = makeMsg(conv.id);
		const { id: mediaId } = makeMedia(u.id);
		linkMessageMedia(msg.id, mediaId);
		archiveConversation(conv.id, u.id);

		const result = listConversationsForMedia(mediaId, u.id);
		expect(result).toHaveLength(1);
		expect(result[0].archivedAt).not.toBeNull();
	});
});

describe('listConversationMediaRefs', () => {
	function makeConv(userId: string) {
		return createConversation({
			userId,
			endpointId: 'bridge',
			modelId: 'bridge::x',
			modelKind: 'image',
		});
	}

	function makeMsg(conversationId: string, parentMessageId: string | null = null) {
		return appendMessage({
			conversationId,
			parentMessageId,
			role: 'assistant',
			parts: [{ type: 'text', text: 'placeholder' }],
		});
	}

	it('returns [] for a conversation with no media', () => {
		const u = seedUser();
		const conv = makeConv(u.id);
		makeMsg(conv.id);
		expect(listConversationMediaRefs(conv.id, u.id)).toEqual([]);
	});

	it('returns [] for a foreign user even when media exists', () => {
		const owner = seedUser();
		const intruder = seedUser();
		const conv = makeConv(owner.id);
		const msg = makeMsg(conv.id);
		const { id } = makeMedia(owner.id);
		linkMessageMedia(msg.id, id);
		expect(listConversationMediaRefs(conv.id, intruder.id)).toEqual([]);
	});

	it('spans sibling branches, not just the active leaf path', async () => {
		// The whole point: a multi-image batch / fan-out is N sibling
		// assistant messages under one parent, only one of which is on the
		// active path. All N images must surface.
		const u = seedUser();
		const conv = makeConv(u.id);
		const parent = appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'user',
			parts: [{ type: 'text', text: 'make four' }],
		});
		const ids: string[] = [];
		for (let i = 0; i < 4; i++) {
			// Siblings: same parent, only the last advances the active leaf.
			const sib = appendMessage({
				conversationId: conv.id,
				parentMessageId: parent.id,
				role: 'assistant',
				parts: [{ type: 'text', text: `variant ${i}` }],
				advanceActiveLeaf: i === 3,
			});
			await new Promise((r) => setTimeout(r, 2)); // strict createdAt order
			const { id } = makeMedia(u.id);
			linkMessageMedia(sib.id, id);
			ids.push(id);
		}

		const result = listConversationMediaRefs(conv.id, u.id);
		expect(result.map((r) => r.id)).toEqual(ids); // all four, oldest first
		expect(result.every((r) => r.kind === 'image')).toBe(true);
	});

	it('dedupes a media referenced by more than one message', () => {
		const u = seedUser();
		const conv = makeConv(u.id);
		const msg1 = makeMsg(conv.id);
		const msg2 = makeMsg(conv.id, msg1.id);
		const { id } = makeMedia(u.id);
		linkMessageMedia(msg1.id, id);
		linkMessageMedia(msg2.id, id);
		expect(listConversationMediaRefs(conv.id, u.id).map((r) => r.id)).toEqual([id]);
	});

	it('excludes file-kind media but keeps images and videos', async () => {
		const u = seedUser();
		const conv = makeConv(u.id);
		const msg = makeMsg(conv.id);
		const img = makeMedia(u.id, { kind: 'image' });
		await new Promise((r) => setTimeout(r, 2));
		const vid = makeMedia(u.id, { kind: 'video', contentType: 'video/mp4' });
		await new Promise((r) => setTimeout(r, 2));
		const file = makeMedia(u.id, { kind: 'file', contentType: 'application/pdf' });
		linkMessageMedia(msg.id, img.id);
		linkMessageMedia(msg.id, vid.id);
		linkMessageMedia(msg.id, file.id);

		const result = listConversationMediaRefs(conv.id, u.id);
		expect(result.map((r) => r.id)).toEqual([img.id, vid.id]);
		expect(result.find((r) => r.id === vid.id)?.kind).toBe('video');
	});

	it('excludes hard-deleted media', () => {
		const u = seedUser();
		const conv = makeConv(u.id);
		const msg = makeMsg(conv.id);
		const live = makeMedia(u.id);
		const gone = makeMedia(u.id);
		linkMessageMedia(msg.id, live.id);
		linkMessageMedia(msg.id, gone.id);
		hardDeleteMediaForUser(gone.id, u.id);

		expect(listConversationMediaRefs(conv.id, u.id).map((r) => r.id)).toEqual([live.id]);
	});

	it('scopes to the conversation, not the whole user library', () => {
		const u = seedUser();
		const convA = makeConv(u.id);
		const convB = makeConv(u.id);
		const msgA = makeMsg(convA.id);
		const msgB = makeMsg(convB.id);
		const a = makeMedia(u.id);
		const b = makeMedia(u.id);
		linkMessageMedia(msgA.id, a.id);
		linkMessageMedia(msgB.id, b.id);

		expect(listConversationMediaRefs(convA.id, u.id).map((r) => r.id)).toEqual([a.id]);
	});
});
