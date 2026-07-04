import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB }));
vi.mock('$lib/server/db/client', () => ({ getDb: () => mocks.testDb, closeDb: () => {} }));

const chatMock = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/endpoints/client', () => ({ chatCompletionSync: chatMock }));

const memModelMock = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/tasks/memory-model', () => ({ getMemoryModel: memModelMock }));

const acquireMock = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/endpoints/concurrency', () => ({ acquireEndpointSlot: acquireMock }));

import { runDreamSweep } from '$lib/server/memory/dreaming';
import {
	createMemory,
	listMemoriesForUser,
	listMemoryTierRows,
	recordMemoryRecall,
	softDeleteMemory,
} from '$lib/server/db/queries/memories';
import { memories } from '$lib/server/db/schema';

const MODEL = {
	endpoint: { id: 'gpu', maxConcurrent: 1 },
	upstreamId: 'm',
	maxTokens: 2000,
	temperature: 0.2,
	activeHours: '',
	timezone: 'UTC',
};

const releaseSpy = vi.fn();

function chatReply(obj: unknown) {
	chatMock.mockResolvedValue({ choices: [{ message: { content: JSON.stringify(obj) } }] });
}

function rowOf(id: string) {
	return mocks.testDb
		.select({ deletedAt: memories.deletedAt, superseded: memories.supersededByMemoryId })
		.from(memories)
		.where(eq(memories.id, id))
		.get()!;
}

beforeEach(() => {
	mocks.testDb = createTestDb();
	chatMock.mockReset();
	memModelMock.mockReset();
	acquireMock.mockReset();
	releaseSpy.mockReset();
	memModelMock.mockReturnValue(MODEL);
	acquireMock.mockResolvedValue({ release: releaseSpy });
});

afterEach(() => closeTestDb());

describe('runDreamSweep', () => {
	it('is a no-op when no memory model is configured', async () => {
		memModelMock.mockReturnValue(null);
		const u = seedUser();
		createMemory(u.id, 'a', 'A');
		createMemory(u.id, 'b', 'B');
		expect(await runDreamSweep()).toEqual({ purged: 0, usersProcessed: 0, opsApplied: 0 });
		expect(chatMock).not.toHaveBeenCalled();
	});

	it('outside the window it purges but does not consult the model', async () => {
		memModelMock.mockReturnValue({ ...MODEL, activeHours: '02:00-06:00', timezone: 'UTC' });
		const u = seedUser();
		createMemory(u.id, 'a', 'A');
		createMemory(u.id, 'b', 'B');
		// Noon UTC — outside 02:00–06:00.
		const r = await runDreamSweep(Date.parse('2026-01-15T12:00:00Z'));
		expect(r.usersProcessed).toBe(0);
		expect(chatMock).not.toHaveBeenCalled();
	});

	it('merges duplicates: survivor updated, source soft-deleted with lineage', async () => {
		const u = seedUser();
		const a = createMemory(u.id, 'has a golden retriever named Max', 'Pet');
		const b = createMemory(u.id, 'owns a dog, a golden retriever called Max', 'Dog');
		chatReply({
			operations: [
				{
					type: 'merge',
					ids: [a.id, b.id],
					content: 'Has a golden retriever named Max',
					topic: 'Pet',
				},
			],
		});

		const r = await runDreamSweep();
		expect(r.opsApplied).toBe(1);
		const live = listMemoriesForUser(u.id);
		expect(live).toHaveLength(1);
		expect(live[0].id).toBe(a.id); // oldest, both recall 0 → survivor
		expect(live[0].content).toBe('Has a golden retriever named Max');
		// The other source is a tombstone pointing at the survivor.
		expect(rowOf(b.id).deletedAt).not.toBeNull();
		expect(rowOf(b.id).superseded).toBe(a.id);
		// Slot acquired on the model's endpoint and released.
		expect(acquireMock).toHaveBeenCalledWith('gpu', 1);
		expect(releaseSpy).toHaveBeenCalled();
	});

	it('keeps the most-recalled memory as the merge survivor', async () => {
		const u = seedUser();
		const a = createMemory(u.id, 'dup one', 'T');
		const b = createMemory(u.id, 'dup two', 'T');
		recordMemoryRecall(u.id, [b.id]); // b is hotter
		chatReply({
			operations: [{ type: 'merge', ids: [a.id, b.id], content: 'merged', topic: 'T' }],
		});

		await runDreamSweep();
		const live = listMemoriesForUser(u.id);
		expect(live.map((m) => m.id)).toEqual([b.id]); // b survived
		expect(rowOf(a.id).superseded).toBe(b.id);
	});

	it('applies reword, retopic, and prune', async () => {
		const u = seedUser();
		const a = createMemory(u.id, 'old job at Acme', 'Job');
		const b = createMemory(u.id, 'topic is sloppy', 'sloppy');
		const c = createMemory(u.id, 'trip that is over', 'Trip');
		chatReply({
			operations: [
				{
					type: 'reword',
					id: a.id,
					content: 'Works at Globex; previously Acme',
					topic: 'Employer',
				},
				{ type: 'retopic', id: b.id, topic: 'Tidy Topic' },
				{ type: 'prune', id: c.id, reason: 'no durable value' },
			],
		});

		const r = await runDreamSweep();
		expect(r.opsApplied).toBe(3);
		const live = listMemoryTierRows(u.id);
		const byId = new Map(live.map((m) => [m.id, m]));
		expect(byId.get(a.id)?.topic).toBe('Employer');
		expect(byId.get(b.id)?.topic).toBe('Tidy Topic');
		expect(byId.has(c.id)).toBe(false); // pruned (soft-deleted)
		expect(rowOf(c.id).deletedAt).not.toBeNull();
	});

	it('skips ops referencing unknown ids (nothing applied)', async () => {
		const u = seedUser();
		createMemory(u.id, 'a', 'A');
		createMemory(u.id, 'b', 'B');
		chatReply({ operations: [{ type: 'prune', id: 'not-a-real-id', reason: 'x' }] });
		const r = await runDreamSweep();
		expect(r.opsApplied).toBe(0);
		expect(listMemoriesForUser(u.id)).toHaveLength(2);
	});

	it('advances the watermark so a settled store is not re-processed', async () => {
		const u = seedUser();
		createMemory(u.id, 'a', 'A');
		createMemory(u.id, 'b', 'B');
		chatReply({ operations: [] }); // model finds nothing to do

		const first = await runDreamSweep();
		expect(first.usersProcessed).toBe(1);
		chatMock.mockClear();
		const second = await runDreamSweep();
		expect(second.usersProcessed).toBe(0); // settled → skipped
		expect(chatMock).not.toHaveBeenCalled();
	});

	it('purges tombstones past the retention cutoff', async () => {
		const u = seedUser();
		const a = createMemory(u.id, 'a', 'A');
		createMemory(u.id, 'b', 'B');
		softDeleteMemory(u.id, a.id, null);
		// Backdate the tombstone to the distant past.
		mocks.testDb.update(memories).set({ deletedAt: 1000 }).where(eq(memories.id, a.id)).run();
		chatReply({ operations: [] });

		const r = await runDreamSweep();
		expect(r.purged).toBe(1);
		expect(
			mocks.testDb
				.select({ id: memories.id })
				.from(memories)
				.all()
				.map((x) => x.id),
		).not.toContain(a.id);
	});
});
