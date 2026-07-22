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
	computeGalleryLayout,
	hardDeleteMediaForUser,
	insertMedia,
	linkMessageMedia,
	listGalleryUnits,
	type GalleryUnit,
} from '$lib/server/db/queries/media';
import { createConversation } from '$lib/server/db/queries/conversations';
import { appendMessage } from '$lib/server/db/queries/messages';
import { media } from '$lib/server/db/schema';

beforeEach(() => {
	mocks.testDb = createTestDb();
});
afterEach(() => {
	closeTestDb();
});

// UTC instant; with tzOffsetMinutes:0 the server buckets by UTC day, so a
// dayKey is just this date's YYYY-MM-DD.
const at = (y: number, mo: number, d: number, h = 12, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);

function makeGen(
	userId: string,
	createdAt: number,
	overrides: Partial<Parameters<typeof insertMedia>[0]> = {},
): string {
	const { id } = insertMedia({
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
	// insertMedia stamps createdAt = Date.now(); pin it for deterministic order.
	mocks.testDb.update(media).set({ createdAt }).where(eq(media.id, id)).run();
	return id;
}

function makeConv(userId: string): string {
	return createConversation({
		userId,
		endpointId: 'bridge',
		modelId: 'bridge::x',
		modelKind: 'chat',
	}).id;
}

/** Assign a media row to a conversation (via a referencing message), the way the
 *  gallery's `assignedConversationId` resolves stacking membership. */
function linkToConv(convId: string, mediaId: string): void {
	const msg = appendMessage({
		conversationId: convId,
		parentMessageId: null,
		role: 'assistant',
		parts: [{ type: 'text', text: '.' }],
	});
	linkMessageMedia(msg.id, mediaId);
}

const TZ = { tzOffsetMinutes: 0 } as const;

/** All units for a user, newest-first (a big single page). */
function allUnits(userId: string, opts = {}): GalleryUnit[] {
	return listGalleryUnits(userId, { ...TZ, ...opts, offset: 0, limit: 500 }).units;
}

describe('gallery units: solos', () => {
	it('distinct-prompt orphans each become one solo unit, newest-first', () => {
		const u = seedUser();
		makeGen(u.id, at(2024, 6, 13), { promptFull: 'a', originalPrompt: null });
		makeGen(u.id, at(2024, 6, 14), { promptFull: 'b', originalPrompt: null });
		const newest = makeGen(u.id, at(2024, 6, 15), { promptFull: 'c', originalPrompt: null });

		const units = allUnits(u.id);
		expect(units.map((x) => x.groupKind)).toEqual(['solo', 'solo', 'solo']);
		expect(units[0].leaderId).toBe(newest); // newest-first
		expect(units[0].memberCount).toBe(1);
		expect(units[0].previews).toHaveLength(1);

		const layout = computeGalleryLayout(u.id, TZ);
		expect(layout.totalUnits).toBe(3);
		expect(layout.days).toEqual([
			{ key: '2024-06-15', units: 1 },
			{ key: '2024-06-14', units: 1 },
			{ key: '2024-06-13', units: 1 },
		]);
	});
});

describe('gallery units: same-prompt run stacking', () => {
	it('collapses consecutive same-prompt orphans within the gap into one unit', () => {
		const u = seedUser();
		// A fan-out: same originalPrompt, seconds apart, same day.
		makeGen(u.id, at(2024, 6, 15, 12, 0), {
			originalPrompt: 'sunset',
			promptFull: 'sunset [sdxl]',
		});
		makeGen(u.id, at(2024, 6, 15, 12, 1), {
			originalPrompt: 'sunset',
			promptFull: 'sunset [flux]',
		});
		const leader = makeGen(u.id, at(2024, 6, 15, 12, 2), {
			originalPrompt: 'sunset',
			promptFull: 'sunset [sd3]',
			promptExcerpt: 'sunset over the sea',
		});

		const units = allUnits(u.id);
		expect(units).toHaveLength(1);
		expect(units[0].groupKind).toBe('prompt');
		expect(units[0].leaderId).toBe(leader); // newest member leads
		expect(units[0].memberCount).toBe(3);
		expect(units[0].previews).toHaveLength(3);
		expect(units[0].excerpt).toBe('sunset over the sea'); // leader's caption

		expect(computeGalleryLayout(u.id, TZ).totalUnits).toBe(1);
	});

	it('does NOT merge the same prompt regenerated beyond the time-gap', () => {
		const u = seedUser();
		makeGen(u.id, at(2024, 6, 15, 9, 0), { originalPrompt: 'moon', promptFull: 'moon' });
		// >1h later (ORPHAN_GAP_MS) → a separate stack, not merged.
		makeGen(u.id, at(2024, 6, 15, 12, 0), { originalPrompt: 'moon', promptFull: 'moon' });

		expect(allUnits(u.id)).toHaveLength(2);
		expect(computeGalleryLayout(u.id, TZ).totalUnits).toBe(2);
	});

	it('caps previews at 4 for a large run but keeps the true memberCount', () => {
		const u = seedUser();
		for (let i = 0; i < 7; i++) {
			makeGen(u.id, at(2024, 6, 15, 12, i), { originalPrompt: 'many', promptFull: `many ${i}` });
		}
		const units = allUnits(u.id);
		expect(units).toHaveLength(1);
		expect(units[0].memberCount).toBe(7);
		expect(units[0].previews).toHaveLength(4);
	});
});

describe('gallery units: global conversation stacking', () => {
	it('collapses a conversation scattered across days into ONE unit at its newest member', () => {
		const u = seedUser();
		const conv = makeConv(u.id);
		// Conversation media on day 15 (newest) and day 13 (oldest), with an
		// unrelated orphan on day 14 sitting BETWEEN them in the stream.
		const newest = makeGen(u.id, at(2024, 6, 15), { promptFull: 'chat-a', originalPrompt: null });
		linkToConv(conv, newest);
		makeGen(u.id, at(2024, 6, 14), { promptFull: 'orphan', originalPrompt: null });
		const older = makeGen(u.id, at(2024, 6, 13), { promptFull: 'chat-a', originalPrompt: null });
		linkToConv(conv, older);

		const units = allUnits(u.id);
		// Two units: the conversation stack (leader = newest, absorbs older) and
		// the day-14 solo. Crucially NOT three — the day-13 member is absorbed.
		expect(units).toHaveLength(2);
		const convUnit = units.find((x) => x.groupKind === 'conversation')!;
		expect(convUnit.leaderId).toBe(newest);
		expect(convUnit.memberCount).toBe(2);
		expect(convUnit.conversationId).toBe(conv);

		// Layout: the conversation counts ONCE, on its newest member's day; day 13
		// contributes nothing (its only media was absorbed into the stack).
		expect(computeGalleryLayout(u.id, TZ).days).toEqual([
			{ key: '2024-06-15', units: 1 },
			{ key: '2024-06-14', units: 1 },
		]);
	});
});

describe('gallery units: stacking off (firehose)', () => {
	it('stack:false yields one solo unit per media, no collapsing', () => {
		const u = seedUser();
		const conv = makeConv(u.id);
		// A conversation stack + a same-prompt run that WOULD collapse when stacked.
		const c1 = makeGen(u.id, at(2024, 6, 15, 10), { promptFull: 'c', originalPrompt: null });
		linkToConv(conv, c1);
		const c2 = makeGen(u.id, at(2024, 6, 15, 9), { promptFull: 'c', originalPrompt: null });
		linkToConv(conv, c2);
		makeGen(u.id, at(2024, 6, 15, 8), { originalPrompt: 'run', promptFull: 'run a' });
		makeGen(u.id, at(2024, 6, 15, 7), { originalPrompt: 'run', promptFull: 'run b' });

		// Stacked: conversation (2) collapses to 1 + run (2) collapses to 1 = 2 units.
		expect(computeGalleryLayout(u.id, TZ).totalUnits).toBe(2);
		// Firehose: all four are their own solo units.
		const flat = computeGalleryLayout(u.id, { ...TZ, stack: false });
		expect(flat.totalUnits).toBe(4);
		const units = listGalleryUnits(u.id, { ...TZ, stack: false, offset: 0, limit: 500 }).units;
		expect(units.every((x) => x.groupKind === 'solo' && x.memberCount === 1)).toBe(true);
	});
});

describe('gallery units: layout ↔ units consistency', () => {
	it('per-day counts sum to totalUnits and each day count matches the units in it', () => {
		const u = seedUser();
		// A mix: a conversation stack, a prompt run, and solos across three days.
		const conv = makeConv(u.id);
		const c1 = makeGen(u.id, at(2024, 6, 15, 10), { promptFull: 'c', originalPrompt: null });
		linkToConv(conv, c1);
		const c2 = makeGen(u.id, at(2024, 6, 13, 10), { promptFull: 'c', originalPrompt: null });
		linkToConv(conv, c2);
		makeGen(u.id, at(2024, 6, 15, 11), { originalPrompt: 'run', promptFull: 'run a' });
		makeGen(u.id, at(2024, 6, 15, 11, 1), { originalPrompt: 'run', promptFull: 'run b' });
		makeGen(u.id, at(2024, 6, 14, 9), { promptFull: 'solo1', originalPrompt: null });
		makeGen(u.id, at(2024, 6, 14, 8), { promptFull: 'solo2', originalPrompt: null });

		const layout = computeGalleryLayout(u.id, TZ);
		const units = allUnits(u.id);
		expect(layout.totalUnits).toBe(units.length);
		expect(layout.days.reduce((n, d) => n + d.units, 0)).toBe(layout.totalUnits);

		// Cross-check: bucket the returned units by dayKey and compare to layout.
		const byDay = new Map<string, number>();
		for (const un of units) byDay.set(un.dayKey, (byDay.get(un.dayKey) ?? 0) + 1);
		expect(layout.days).toEqual([...byDay.entries()].map(([key, u2]) => ({ key, units: u2 })));
	});
});

describe('gallery units: offset paging', () => {
	it('contiguous offset slices reassemble the full newest-first list', () => {
		const u = seedUser();
		for (let i = 0; i < 10; i++) {
			makeGen(u.id, at(2024, 6, 20) - i * 86_400_000, {
				promptFull: `p${i}`,
				originalPrompt: null,
			});
		}
		const full = allUnits(u.id).map((x) => x.key);
		expect(full).toHaveLength(10);

		const p0 = listGalleryUnits(u.id, { ...TZ, offset: 0, limit: 4 });
		const p1 = listGalleryUnits(u.id, { ...TZ, offset: 4, limit: 4 });
		const p2 = listGalleryUnits(u.id, { ...TZ, offset: 8, limit: 4 });
		expect(p0.total).toBe(10);
		expect(p1.total).toBe(10);
		expect([...p0.units, ...p1.units, ...p2.units].map((x) => x.key)).toEqual(full);
		expect(p2.units).toHaveLength(2); // last short page
	});

	it('an offset past the end returns an empty page with the real total', () => {
		const u = seedUser();
		makeGen(u.id, at(2024, 6, 15), { promptFull: 'x', originalPrompt: null });
		const page = listGalleryUnits(u.id, { ...TZ, offset: 50, limit: 10 });
		expect(page.units).toEqual([]);
		expect(page.total).toBe(1);
	});
});

describe('gallery units: filters', () => {
	it('kind filter excludes the other modality from counts and units', () => {
		const u = seedUser();
		makeGen(u.id, at(2024, 6, 15), { kind: 'image', promptFull: 'img', originalPrompt: null });
		makeGen(u.id, at(2024, 6, 14), { kind: 'video', promptFull: 'vid', originalPrompt: null });

		expect(computeGalleryLayout(u.id, { ...TZ }).totalUnits).toBe(2);
		expect(computeGalleryLayout(u.id, { ...TZ, kind: 'image' }).totalUnits).toBe(1);
		const vids = allUnits(u.id, { kind: 'video' });
		expect(vids).toHaveLength(1);
		expect(vids[0].leaderKind).toBe('video');
	});

	it('model filter restricts to one source_model', () => {
		const u = seedUser();
		makeGen(u.id, at(2024, 6, 15), { sourceModel: 'sdxl', promptFull: 'a', originalPrompt: null });
		makeGen(u.id, at(2024, 6, 14), { sourceModel: 'flux', promptFull: 'b', originalPrompt: null });
		expect(computeGalleryLayout(u.id, { ...TZ, model: 'flux' }).totalUnits).toBe(1);
	});

	it('excludes uploaded (non-generated) media', () => {
		const u = seedUser();
		makeGen(u.id, at(2024, 6, 15), { promptFull: 'gen', originalPrompt: null });
		makeGen(u.id, at(2024, 6, 14), { origin: 'uploaded', promptFull: 'up', originalPrompt: null });
		expect(computeGalleryLayout(u.id, TZ).totalUnits).toBe(1);
	});
});

describe('gallery units: cache invalidation on mutation', () => {
	it('a delete is reflected on the next query (the memo is invalidated)', () => {
		const u = seedUser();
		const a = makeGen(u.id, at(2024, 6, 15), { promptFull: 'a', originalPrompt: null });
		makeGen(u.id, at(2024, 6, 14), { promptFull: 'b', originalPrompt: null });

		// Populate the per-(user, filter, tz) unit-list cache.
		expect(listGalleryUnits(u.id, { ...TZ, offset: 0, limit: 500 }).total).toBe(2);

		// Delete one; the next query must recompute, not serve the cached list of 2.
		hardDeleteMediaForUser(a, u.id);
		expect(listGalleryUnits(u.id, { ...TZ, offset: 0, limit: 500 }).total).toBe(1);
		expect(computeGalleryLayout(u.id, TZ).totalUnits).toBe(1);
	});
});

describe('gallery units: tz bucketing', () => {
	it('shifts a near-midnight row into the adjacent local day with the offset', () => {
		const u = seedUser();
		// 2024-06-15 00:30 UTC → same UTC day; at -60min it's 2024-06-14 23:30 local.
		makeGen(u.id, Date.UTC(2024, 5, 15, 0, 30), { promptFull: 'edge', originalPrompt: null });
		expect(computeGalleryLayout(u.id, { tzOffsetMinutes: 0 }).days[0].key).toBe('2024-06-15');
		expect(computeGalleryLayout(u.id, { tzOffsetMinutes: -60 }).days[0].key).toBe('2024-06-14');
	});
});
