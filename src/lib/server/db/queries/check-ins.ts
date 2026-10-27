/**
 * Pending texting check-ins (see `#lib/check-ins.ts`). Every read a request can
 * reach is scoped by `user_id`; `listDueCheckIns` is the runner's cross-user
 * sweep, never a request's.
 */
import { and, asc, eq, lte } from 'drizzle-orm';
import type { PendingCheckIn } from '#lib/types/api.js';
import { generateId } from '../../util/id';
import { getDb } from '../client';
import { checkIns } from '../schema';

export type CheckInRow = typeof checkIns.$inferSelect;

/** Set a conversation's check-in, replacing any it already had. */
export function setCheckIn(input: {
	userId: string;
	conversationId: string;
	sourceMessageId: string;
	note: string;
	fireAt: number;
	now?: number;
}): void {
	const values = {
		sourceMessageId: input.sourceMessageId,
		note: input.note,
		fireAt: input.fireAt,
		createdAt: input.now ?? Date.now(),
	};
	getDb()
		.insert(checkIns)
		.values({
			id: generateId(),
			userId: input.userId,
			conversationId: input.conversationId,
			...values,
		})
		.onConflictDoUpdate({ target: checkIns.conversationId, set: values })
		.run();
}

export function getCheckIn(conversationId: string, userId: string): PendingCheckIn | null {
	const row = getDb()
		.select({
			sourceMessageId: checkIns.sourceMessageId,
			fireAt: checkIns.fireAt,
			note: checkIns.note,
		})
		.from(checkIns)
		.where(and(eq(checkIns.conversationId, conversationId), eq(checkIns.userId, userId)))
		.get();
	return row ?? null;
}

/** Cancel a conversation's check-in. Returns whether there was one. */
export function deleteCheckIn(conversationId: string, userId: string): boolean {
	const res = getDb()
		.delete(checkIns)
		.where(and(eq(checkIns.conversationId, conversationId), eq(checkIns.userId, userId)))
		.run();
	return Number(res.changes) > 0;
}

/** Delete one check-in by id — the runner's, once it has dealt with it. A
 *  replacement set meanwhile reuses the conversation's row under the same id,
 *  so this also checks it still fires when the runner thought it did. */
export function deleteCheckInIfUnchanged(id: string, fireAt: number): void {
	getDb()
		.delete(checkIns)
		.where(and(eq(checkIns.id, id), eq(checkIns.fireAt, fireAt)))
		.run();
}

/** Check-ins due by `now`, oldest first. The runner's sweep — across users. */
export function listDueCheckIns(now: number, limit: number): CheckInRow[] {
	return getDb()
		.select()
		.from(checkIns)
		.where(lte(checkIns.fireAt, now))
		.orderBy(asc(checkIns.fireAt), asc(checkIns.id))
		.limit(limit)
		.all();
}
