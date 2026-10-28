/**
 * Pictures drawn for a message — see `messageImages` in the schema. Today
 * that is a texting reply's developed photos: every version of each of its
 * `[photo: …]`, plus a failed attempt until the next one replaces it.
 *
 * Reads take ids the caller has already scoped (the chat page resolves the
 * conversation for its user first, as every messages read does); writes that
 * a request makes are scoped by user id here.
 */
import { and, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import { getDb, type Tx } from '../client';
import { media, messageImages } from '../schema';
import type { MessageImage } from '#lib/types/api.js';

export type NewMessageImage = typeof messageImages.$inferInsert;

/** Record a version (or a failed attempt), in the transaction that consumes
 *  its generation job. A landed photo also clears the failure it retried. */
export function insertMessageImage(tx: Tx, row: NewMessageImage): void {
	if (row.mediaId) {
		tx.delete(messageImages)
			.where(
				and(
					eq(messageImages.messageId, row.messageId),
					markerIs(row.markerIndex ?? null),
					isNull(messageImages.mediaId),
				),
			)
			.run();
	}
	tx.insert(messageImages).values(row).run();
}

/** Forget a marker's failed attempts — a new one is under way. */
export function clearImageFailures(messageId: string, markerIndex: number | null): void {
	getDb()
		.delete(messageImages)
		.where(
			and(
				eq(messageImages.messageId, messageId),
				markerIs(markerIndex),
				isNull(messageImages.mediaId),
			),
		)
		.run();
}

/** Whether a marker has a version on show already — a comparison's first
 *  result takes the stage only when nothing else holds it. */
export function hasShownImage(tx: Tx, messageId: string, markerIndex: number | null): boolean {
	return !!tx
		.select({ id: messageImages.id })
		.from(messageImages)
		.innerJoin(media, eq(media.id, messageImages.mediaId))
		.where(
			and(eq(messageImages.messageId, messageId), markerIs(markerIndex), isNull(media.deletedAt)),
		)
		.limit(1)
		.get();
}

/**
 * The models that drew `ids` — the versions of one photo a comparison showed
 * alongside `of` — keyed to the user, the conversation and that same photo, so
 * a pick can't count models from anywhere else. `of`'s own model first.
 */
export function comparedModels(
	userId: string,
	conversationId: string,
	of: string,
	ids: string[],
): { winner: string; models: string[] } | null {
	const db = getDb();
	const picked = db
		.select()
		.from(messageImages)
		.where(
			and(
				eq(messageImages.id, of),
				eq(messageImages.userId, userId),
				eq(messageImages.conversationId, conversationId),
			),
		)
		.get();
	if (!picked?.mediaId || ids.length === 0) return null;
	const models = db
		.select({ modelId: messageImages.modelId })
		.from(messageImages)
		.where(
			and(
				inArray(messageImages.id, ids),
				eq(messageImages.messageId, picked.messageId),
				markerIs(picked.markerIndex),
				isNotNull(messageImages.mediaId),
			),
		)
		.all()
		.map((r) => r.modelId);
	return { winner: picked.modelId, models };
}

/**
 * Put one version on show. Scoped to the user and the conversation, and to
 * versions that exist — a failed attempt or a trashed image has nothing to
 * show. False when there was no such version.
 */
export function showMessageImage(userId: string, conversationId: string, id: string): boolean {
	const db = getDb();
	const target = db
		.select({ id: messageImages.id })
		.from(messageImages)
		.innerJoin(media, eq(media.id, messageImages.mediaId))
		.where(
			and(
				eq(messageImages.id, id),
				eq(messageImages.userId, userId),
				eq(messageImages.conversationId, conversationId),
				isNull(media.deletedAt),
			),
		)
		.get();
	if (!target) return false;
	db.update(messageImages).set({ shownAt: Date.now() }).where(eq(messageImages.id, id)).run();
	return true;
}

/**
 * The versions of every picture drawn for `messageIds`, by message, oldest
 * first — with which one each marker shows. A version whose image is in the
 * trash is left out (it comes back if the image is restored).
 */
export function listImagesForMessages(
	conversationId: string,
	messageIds: string[],
): Map<string, MessageImage[]> {
	const out = new Map<string, MessageImage[]>();
	if (messageIds.length === 0) return out;
	const rows = getDb()
		.select({
			id: messageImages.id,
			messageId: messageImages.messageId,
			kind: messageImages.kind,
			markerIndex: messageImages.markerIndex,
			mediaId: messageImages.mediaId,
			modelId: messageImages.modelId,
			error: messageImages.error,
			shownAt: messageImages.shownAt,
			createdAt: messageImages.createdAt,
			aspectRatio: media.aspectRatio,
			width: media.width,
			height: media.height,
		})
		.from(messageImages)
		.leftJoin(media, eq(media.id, messageImages.mediaId))
		.where(
			and(
				eq(messageImages.conversationId, conversationId),
				inArray(messageImages.messageId, messageIds),
				or(isNull(messageImages.mediaId), isNull(media.deletedAt)),
			),
		)
		.orderBy(messageImages.createdAt, messageImages.id)
		.all();

	// The shown version per (message, marker): the latest `shown_at`, else the
	// newest version.
	const shown = new Map<string, { id: string; shownAt: number; createdAt: number }>();
	for (const r of rows) {
		if (!r.mediaId) continue;
		const key = `${r.messageId}\u0000${r.markerIndex}`;
		const best = shown.get(key);
		const shownAt = r.shownAt ?? -1;
		if (
			!best ||
			shownAt > best.shownAt ||
			(shownAt === best.shownAt && r.createdAt >= best.createdAt)
		) {
			shown.set(key, { id: r.id, shownAt, createdAt: r.createdAt });
		}
	}
	for (const r of rows) {
		let list = out.get(r.messageId);
		if (!list) out.set(r.messageId, (list = []));
		list.push({
			id: r.id,
			kind: r.kind,
			markerIndex: r.markerIndex,
			mediaId: r.mediaId,
			error: r.error,
			modelId: r.modelId,
			shown: shown.get(`${r.messageId}\u0000${r.markerIndex}`)?.id === r.id,
			aspectRatio: r.aspectRatio ?? null,
			width: r.width ?? null,
			height: r.height ?? null,
			createdAt: r.createdAt,
		});
	}
	return out;
}

function markerIs(markerIndex: number | null) {
	return markerIndex === null
		? isNull(messageImages.markerIndex)
		: eq(messageImages.markerIndex, markerIndex);
}
