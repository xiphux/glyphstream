/**
 * Pictures drawn for a message — see `messageImages` in the schema. Today
 * that is a texting reply's developed photos: every version of each of its
 * `[photo: …]`, plus a failed attempt until the next one replaces it.
 *
 * Reads take ids the caller has already scoped (the chat page resolves the
 * conversation for its user first, as every messages read does); writes that
 * a request makes are scoped by user id here.
 */
import { and, eq, inArray, isNotNull, isNull, ne, or } from 'drizzle-orm';
import { getDb, type Tx } from '../client';
import { media, messageImages } from '../schema';
import type { MessageImage } from '#lib/types/api.js';

export type NewMessageImage = typeof messageImages.$inferInsert;

/** Record a version (or a failed attempt), in the transaction that consumes
 *  its generation job. A landed photo also clears the failure it retried —
 *  but not a failure from its own comparison, which is one of the results
 *  being compared. */
export function insertMessageImage(tx: Tx, row: NewMessageImage): void {
	if (row.mediaId) {
		tx.delete(messageImages)
			.where(failuresOutside(row.messageId, row.markerIndex ?? null, row.comparisonId ?? null))
			.run();
	}
	tx.insert(messageImages).values(row).run();
}

/** Forget a marker's failed attempts — a new one is under way. A draw in a
 *  comparison (`comparisonId`) leaves that comparison's own failures alone:
 *  they're still on show in it. */
export function clearImageFailures(
	messageId: string,
	markerIndex: number | null,
	comparisonId: string | null = null,
): void {
	getDb()
		.delete(messageImages)
		.where(failuresOutside(messageId, markerIndex, comparisonId))
		.run();
}

/** A marker's failed attempts, except `comparisonId`'s (none excepted when null). */
function failuresOutside(
	messageId: string,
	markerIndex: number | null,
	comparisonId: string | null,
) {
	return and(
		eq(messageImages.messageId, messageId),
		markerIs(markerIndex),
		isNull(messageImages.mediaId),
		comparisonId === null
			? undefined
			: or(isNull(messageImages.comparisonId), ne(messageImages.comparisonId, comparisonId)),
	);
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

/** How many results with an image a comparison still open has drawn. */
export function countComparisonResults(
	userId: string,
	messageId: string,
	comparisonId: string,
): number {
	return getDb()
		.select({ id: messageImages.id })
		.from(messageImages)
		.where(
			and(
				eq(messageImages.userId, userId),
				eq(messageImages.messageId, messageId),
				eq(messageImages.comparisonId, comparisonId),
				isNotNull(messageImages.mediaId),
			),
		)
		.all().length;
}

/**
 * Resolve the comparison `id` was drawn in, if it is still open: the models
 * that drew its versions, `id`'s first, and the comparison closed (its failed
 * draws dropped) in the same transaction — so a pick is counted once, however
 * often it is sent, and only for versions the server drew together. Null when
 * there's nothing to count.
 */
export function resolveComparison(
	userId: string,
	conversationId: string,
	id: string,
): { winner: string; models: string[]; messageId: string; comparisonId: string } | null {
	return getDb().transaction((tx) => {
		const picked = tx
			.select()
			.from(messageImages)
			.where(
				and(
					eq(messageImages.id, id),
					eq(messageImages.userId, userId),
					eq(messageImages.conversationId, conversationId),
				),
			)
			.get();
		if (!picked?.mediaId || !picked.comparisonId) return null;
		const inComparison = and(
			eq(messageImages.messageId, picked.messageId),
			eq(messageImages.comparisonId, picked.comparisonId),
		);
		// Results only, and not one the user threw out before picking — the same
		// as a deleted column in a fan-out pick.
		const models = tx
			.select({ modelId: messageImages.modelId })
			.from(messageImages)
			.innerJoin(media, eq(media.id, messageImages.mediaId))
			.where(and(inComparison, isNull(media.deletedAt)))
			.all()
			.map((r) => r.modelId);
		// Its failed draws were results to compare, not news about the photo:
		// once one is picked they'd only read as the photo failing.
		tx.delete(messageImages)
			.where(and(inComparison, isNull(messageImages.mediaId)))
			.run();
		tx.update(messageImages).set({ comparisonId: null }).where(inComparison).run();
		return {
			winner: picked.modelId,
			models,
			messageId: picked.messageId,
			comparisonId: picked.comparisonId,
		};
	});
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
