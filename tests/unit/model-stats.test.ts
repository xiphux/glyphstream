/**
 * The model-stats write side (`server/stats/model-stats.ts`) and the usage
 * backfill migration that seeds it.
 *
 * The backfill's SQL is read from the shipped file and re-run by hand against
 * seeded rows: `createTestDb()` already applied it to an empty database, where
 * it was a no-op.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

import {
	bestEffort,
	modelRefOf,
	recordModelEvent,
	statsDay,
} from '#lib/server/stats/model-stats.js';
import { createConversation } from '#lib/server/db/queries/conversations.js';
import { appendMessage } from '#lib/server/db/queries/messages.js';
import { insertMedia, linkMessageMedia } from '#lib/server/db/queries/media.js';
import { deleteUser } from '#lib/server/db/queries/users.js';
import { modelStatsDaily, modelUserUsage } from '#lib/server/db/schema.js';

let db: TestDB;
beforeEach(() => {
	db = createTestDb();
});
afterEach(() => closeTestDb());

const DAY1 = Date.UTC(2026, 9, 1, 12);
const DAY2 = Date.UTC(2026, 9, 2, 23, 59);

function counters() {
	return db
		.select()
		.from(modelStatsDaily)
		.orderBy(modelStatsDaily.day, modelStatsDaily.modelId, modelStatsDaily.metric)
		.all();
}

describe('modelRefOf', () => {
	it('splits a stored id into endpoint + upstream', () => {
		expect(modelRefOf('bridge::meta-llama/Llama-3')).toEqual({
			endpointId: 'bridge',
			modelId: 'meta-llama/Llama-3',
		});
	});

	it('is null for ids that name no endpoint', () => {
		expect(modelRefOf('run_python')).toBeNull();
		expect(modelRefOf(null)).toBeNull();
		expect(modelRefOf('')).toBeNull();
	});
});

describe('bestEffort', () => {
	it("returns the lookup's result, or undefined and a warning when it throws", () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(bestEffort('x', () => 42)).toBe(42);
		expect(
			bestEffort('x', () => {
				throw new Error('SQLITE_BUSY');
			}),
		).toBeUndefined();
		expect(warn).toHaveBeenCalledTimes(1);
		warn.mockRestore();
	});
});

describe('recordModelEvent', () => {
	it('accumulates count + sum per (day, model, metric)', () => {
		recordModelEvent('local::qwen', 'turn', { sum: 100, at: DAY1 });
		recordModelEvent('local::qwen', 'turn', { sum: 50, at: DAY1 });
		recordModelEvent('local::qwen', 'turn', { sum: 7, at: DAY2 });
		recordModelEvent({ endpointId: 'local', modelId: 'qwen' }, 'retry', { at: DAY1 });

		expect(counters()).toEqual([
			{
				day: '2026-10-01',
				endpointId: 'local',
				modelId: 'qwen',
				metric: 'retry',
				count: 1,
				sum: 0,
			},
			{
				day: '2026-10-01',
				endpointId: 'local',
				modelId: 'qwen',
				metric: 'turn',
				count: 2,
				sum: 150,
			},
			{ day: '2026-10-02', endpointId: 'local', modelId: 'qwen', metric: 'turn', count: 1, sum: 7 },
		]);
	});

	it('buckets by UTC day', () => {
		expect(statsDay(Date.UTC(2026, 9, 2, 23, 59, 59))).toBe('2026-10-02');
		expect(statsDay(Date.UTC(2026, 9, 3, 0, 0, 0))).toBe('2026-10-03');
	});

	it('ignores a model id with no endpoint', () => {
		recordModelEvent('run_python', 'generated');
		recordModelEvent(null, 'generated');
		expect(counters()).toEqual([]);
	});

	it('stamps the latest use per user, and never moves it backwards', () => {
		const a = seedUser();
		const b = seedUser();
		recordModelEvent('local::qwen', 'turn', { userId: a.id, at: DAY2 });
		recordModelEvent('local::qwen', 'turn', { userId: a.id, at: DAY1 });
		recordModelEvent('local::qwen', 'turn', { userId: b.id, at: DAY1 });
		// A reaction to an old output isn't a use.
		recordModelEvent('local::qwen', 'retry', { at: DAY2 + 1000 });

		const rows = db.select().from(modelUserUsage).all();
		expect(rows).toHaveLength(2);
		expect(rows.find((r) => r.userId === a.id)?.lastUsedAt).toBe(DAY2);
		expect(rows.find((r) => r.userId === b.id)?.lastUsedAt).toBe(DAY1);
	});

	it("drops a deleted user's usage rows, but not the anonymous counters", () => {
		const u = seedUser();
		recordModelEvent('local::qwen', 'turn', { userId: u.id, at: DAY1 });
		deleteUser(u.id);
		expect(db.select().from(modelUserUsage).all()).toEqual([]);
		expect(counters()).toHaveLength(1);
	});

	it('swallows a write failure instead of throwing into the caller', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		db.run(sql`DROP TABLE model_stats_daily`);
		expect(() => recordModelEvent('local::qwen', 'turn')).not.toThrow();
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});
});

describe('backfill migration', () => {
	const dir = readdirSync(resolve('./drizzle')).find((d) => d.endsWith('_model_stats_backfill'));
	if (!dir) throw new Error('model_stats_backfill migration directory not found');
	const statements = readFileSync(resolve(`./drizzle/${dir}/migration.sql`), 'utf-8')
		.split('--> statement-breakpoint')
		.map((s) => s.trim())
		.filter(Boolean);

	function runBackfill() {
		for (const s of statements) db.run(sql.raw(s));
	}

	function seedChat(userId: string) {
		const conv = createConversation({
			userId,
			endpointId: 'local',
			modelId: 'local::qwen',
			modelKind: 'chat',
		});
		const user = appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'user',
			parts: [{ type: 'text', text: 'hi' }],
		});
		return { conv, user };
	}

	it('counts one turn per reply, skipping tool-loop steps and error siblings', () => {
		const u = seedUser();
		const { conv, user } = seedChat(u.id);
		const step = appendMessage({
			conversationId: conv.id,
			parentMessageId: user.id,
			role: 'assistant',
			parts: [{ type: 'text', text: 'calling a tool' }],
			modelUsed: 'local::qwen',
			finishReason: 'tool_calls',
			tokensOut: 10,
			genMs: 100,
		});
		const result = appendMessage({
			conversationId: conv.id,
			parentMessageId: step.id,
			role: 'tool',
			parts: [{ type: 'tool_result', toolCallId: 'c1', result: 'ok' }],
		});
		appendMessage({
			conversationId: conv.id,
			parentMessageId: result.id,
			role: 'assistant',
			parts: [{ type: 'text', text: 'done' }],
			modelUsed: 'local::qwen',
			finishReason: 'stop',
			tokensOut: 30,
			genMs: 300,
		});
		appendMessage({
			conversationId: conv.id,
			parentMessageId: user.id,
			role: 'assistant',
			parts: [{ type: 'error', message: 'upstream 500' }],
			modelUsed: 'local::qwen',
		});

		runBackfill();
		const rows = counters();
		const turn = rows.find((r) => r.metric === 'turn')!;
		expect(turn.count).toBe(1);
		const speedTokens = rows.find((r) => r.metric === 'speed_tokens')!;
		const speedMs = rows.find((r) => r.metric === 'speed_ms')!;
		expect([speedTokens.count, speedTokens.sum]).toEqual([2, 40]);
		expect([speedMs.count, speedMs.sum]).toEqual([2, 400]);
	});

	it('counts a turn that ended on its tool step, as a reply with a reaction does', () => {
		const u = seedUser();
		const { conv, user } = seedChat(u.id);
		const reply = appendMessage({
			conversationId: conv.id,
			parentMessageId: user.id,
			role: 'assistant',
			parts: [
				{ type: 'text', text: 'Congratulations!' },
				{ type: 'tool_call', toolCallId: 'r1', toolName: 'react_to_message', arguments: '{}' },
			],
			modelUsed: 'local::qwen',
			finishReason: 'tool_calls',
		});
		appendMessage({
			conversationId: conv.id,
			parentMessageId: reply.id,
			role: 'tool',
			parts: [{ type: 'tool_result', toolCallId: 'r1', result: 'ok' }],
		});

		runBackfill();
		expect(counters().filter((r) => r.metric === 'turn')).toMatchObject([{ count: 1 }]);
	});

	it('does not count a generation whose output was trashed, or a failed finish, as a turn', () => {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::flux',
			modelKind: 'image',
		});
		const user = appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'user',
			parts: [{ type: 'text', text: 'a cat' }],
		});
		// Trashing the output deleted its message_media link; the part remains.
		appendMessage({
			conversationId: conv.id,
			parentMessageId: user.id,
			role: 'assistant',
			parts: [{ type: 'image', mediaId: 'trashed-one' }],
			modelUsed: 'bridge::flux',
		});
		appendMessage({
			conversationId: conv.id,
			parentMessageId: user.id,
			role: 'assistant',
			parts: [{ type: 'text', text: 'half a rep' }],
			modelUsed: 'local::qwen',
			finishReason: 'error',
			tokensOut: 5,
			genMs: 50,
		});

		runBackfill();
		expect(counters().filter((r) => r.metric === 'turn' || r.metric.startsWith('speed'))).toEqual(
			[],
		);
	});

	it('does not count a compaction summary as a turn', () => {
		const u = seedUser();
		const { conv, user } = seedChat(u.id);
		appendMessage({
			conversationId: conv.id,
			parentMessageId: user.id,
			role: 'assistant',
			parts: [{ type: 'text', text: 'Summary of the conversation so far' }],
			modelUsed: 'local::qwen',
			compactionResumeFromMessageId: user.id,
		});

		runBackfill();
		expect(counters().filter((r) => r.metric === 'turn')).toEqual([]);
	});

	it('counts generated media from media rows, not from their carrier message', () => {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::flux',
			modelKind: 'image',
		});
		const user = appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'user',
			parts: [{ type: 'text', text: 'a cat' }],
		});
		const m = insertMedia({
			userId: u.id,
			storagePath: 'a.png',
			contentType: 'image/png',
			byteSize: 1,
			kind: 'image',
			sourceEndpointId: 'bridge',
			sourceModel: 'bridge::flux',
			promptExcerpt: 'a cat',
		});
		const reply = appendMessage({
			conversationId: conv.id,
			parentMessageId: user.id,
			role: 'assistant',
			parts: [{ type: 'image', mediaId: m.id }],
			modelUsed: 'bridge::flux',
		});
		linkMessageMedia(reply.id, m.id);
		// A code-interpreter plot is "generated" but names no model.
		insertMedia({
			userId: u.id,
			storagePath: 'plot.png',
			contentType: 'image/png',
			byteSize: 1,
			kind: 'image',
			sourceEndpointId: null,
			sourceModel: 'run_python',
			promptExcerpt: null,
		});

		runBackfill();
		const rows = counters();
		expect(rows.filter((r) => r.metric === 'turn')).toEqual([]);
		expect(rows.filter((r) => r.metric === 'generated')).toMatchObject([
			{ endpointId: 'bridge', modelId: 'flux', count: 1 },
		]);
		expect(db.select().from(modelUserUsage).all()).toMatchObject([
			{ endpointId: 'bridge', modelId: 'flux', userId: u.id },
		]);
	});
});
