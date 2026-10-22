/**
 * Media rows themselves: inserting one, linking it to the message (or avatar)
 * that references it, and reading one back for its owner. Ref counts move here;
 * the purger's side of them is in `maintenance.ts`.
 */
import { and, asc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { generateId } from '../../../util/id';
import { getDb, type Tx } from '../../client';
import { media, messageMedia } from '../../schema';
import type { MediaKind, MessagePart } from '#lib/types/api.js';
import { storedDimensions, type ImageDimensions } from '../../../media/dimensions';

export interface MediaInsertInput {
	userId: string;
	storagePath: string;
	contentType: string;
	byteSize: number;
	kind: MediaKind;
	sourceEndpointId: string | null;
	sourceModel: string | null;
	/** Input image this asset was edited / animated from (i2i edit, i2v).
	 *  Null for text-to-image and uploads. */
	sourceMediaId?: string | null;
	/** Truncated preview (~500 chars) for space-constrained surfaces. */
	promptExcerpt: string | null;
	/** Full original prompt for "regenerate from gallery" flows. May
	 *  share a value with `promptExcerpt` on legacy rows backfilled by
	 *  the 0005 migration. Null for uploads (no prompt). */
	promptFull?: string | null;
	/** The user's pre-enhancement prompt, when the enhancer rewrote it before
	 *  generation (`promptFull`/`promptExcerpt` then hold the ENHANCED prompt).
	 *  Null when no enhancement happened or for uploads. */
	originalPrompt?: string | null;
	/** The aspect ratio the upstream reported it rendered at (its echo, not the
	 *  request — a model may snap to its nearest offered shape). Null for uploads
	 *  and for upstreams that don't deal in ratios. */
	aspectRatio?: string | null;
	/** The image's upright pixel size (`probeImageDimensions`). Omit for
	 *  non-images, which never carry one. */
	dimensions?: ImageDimensions;
	/**
	 * Defaults to 'generated' (produced by an upstream model). Use 'uploaded'
	 * for user-supplied chat attachments — those get `unreferenced_since` set
	 * immediately so the purger can sweep up files that the user picked but
	 * never actually sent.
	 */
	origin?: 'generated' | 'uploaded';
	/**
	 * Original on-disk filename from the upload, e.g. "Q4-budget.xlsx".
	 * Null for legacy rows and AI-generated images/videos. Lets the code
	 * interpreter mount the file under its real name and the attachment
	 * chip surface it as the display label.
	 */
	originalFilename?: string | null;
}

/** Insert a fresh media row (ref_count = 0; caller links it via linkMessageMedia). */
export function insertMedia(input: MediaInsertInput): { id: string } {
	const db = getDb();
	const id = generateId();
	const now = Date.now();
	const origin = input.origin ?? 'generated';
	db.insert(media)
		.values({
			id,
			userId: input.userId,
			storagePath: input.storagePath,
			contentType: input.contentType,
			byteSize: input.byteSize,
			kind: input.kind,
			origin,
			sourceEndpointId: input.sourceEndpointId,
			sourceModel: input.sourceModel,
			sourceMediaId: input.sourceMediaId ?? null,
			promptExcerpt: input.promptExcerpt,
			promptFull: input.promptFull ?? null,
			originalPrompt: input.originalPrompt ?? null,
			aspectRatio: input.aspectRatio ?? null,
			width: input.dimensions?.width ?? null,
			height: input.dimensions?.height ?? null,
			originalFilename: input.originalFilename ?? null,
			createdAt: now,
			refCount: 0,
			// Uploads start in the "candidate for purge" state — if the user
			// picks a file but never sends the message, the existing purger
			// will sweep it after the grace period. linkMessageMedia clears
			// this back to null when the file actually gets attached.
			unreferencedSince: origin === 'uploaded' ? now : null,
			deletedAt: null,
		})
		.run();
	return { id };
}

/** Link a media asset to a message and bump ref_count. Idempotent (PK on the join). */
export function linkMessageMedia(messageId: string, mediaId: string, outer?: Tx): void {
	// Joins the caller's transaction when given one — node:sqlite can't nest a
	// root-level transaction (see `Tx`).
	const link = (tx: Tx) => {
		const inserted = tx
			.insert(messageMedia)
			.values({ messageId, mediaId })
			.onConflictDoNothing()
			.run();
		if (inserted.changes > 0) {
			tx.update(media)
				.set({
					refCount: sql`${media.refCount} + 1`,
					unreferencedSince: null,
				})
				.where(eq(media.id, mediaId))
				.run();
		}
	};
	if (outer) link(outer);
	else getDb().transaction(link);
}

/**
 * Take / release a NON-message reference on a media row.
 *
 * Ref-counting was built around `message_media`, but `media.ref_count` is a
 * plain decrement-based counter, not a cached COUNT(*) over that join table
 * (see `decrementMediaForMessages`, which subtracts a per-message tally rather
 * than recomputing). So a referrer that isn't a message can participate simply
 * by holding a count, and two things then work with no further plumbing:
 *
 *   - the purger leaves the row alone (`findPurgeCandidates` only reaps
 *     uploaded rows whose `unreferenced_since` is set, and taking a reference
 *     clears it) — without this, an uploaded avatar is swept 30 minutes later;
 *   - the delete-conversation orphan analysis stops offering the row, because
 *     it only counts a media as orphaned when the conversation's own join rows
 *     account for the row's ENTIRE ref_count. The avatar's +1 makes them
 *     unequal, so "also delete media" can't pull the face out from under a
 *     preset that's still using it.
 *
 * Both take the caller's `tx`: node:sqlite won't promote a nested
 * `db.transaction()` to a savepoint, and every caller already holds one —
 * releasing an avatar reference is always part of a larger write (setting or
 * clearing an avatar, or deleting the preset / conversation that held it),
 * never a standalone one. Neither is idempotent —
 * unlike `linkMessageMedia`, there's no join-table PK to absorb a double call,
 * so the caller must only invoke these when the avatar actually changes.
 */
export function linkAvatarMedia(tx: Tx, mediaId: string): void {
	tx.update(media)
		.set({ refCount: sql`${media.refCount} + 1`, unreferencedSince: null })
		.where(eq(media.id, mediaId))
		.run();
}

/** Release an avatar's reference. Mirrors `decrementMediaForMessages`: clamp at
 *  zero, and stamp `unreferenced_since` on the way to zero so an uploaded row
 *  re-enters the purger's grace-period clock (a generated one is still never
 *  reaped — that's the library model, enforced in `findPurgeCandidates`). */
export function unlinkAvatarMedia(tx: Tx, mediaId: string): void {
	const now = Date.now();
	tx.update(media)
		.set({
			refCount: sql`MAX(${media.refCount} - 1, 0)`,
			unreferencedSince: sql`CASE WHEN MAX(${media.refCount} - 1, 0) = 0 THEN ${now} ELSE ${media.unreferencedSince} END`,
		})
		.where(eq(media.id, mediaId))
		.run();
}

/** Look up a media row owned by `userId` (returns null on not-found / ownership mismatch). */
export function getMediaForUser(
	mediaId: string,
	userId: string,
): {
	id: string;
	storagePath: string;
	contentType: string;
	byteSize: number;
	kind: MediaKind;
	originalFilename: string | null;
	deletedAt: number | null;
	purgedAt: number | null;
} | null {
	const db = getDb();
	const row = db
		.select({
			id: media.id,
			storagePath: media.storagePath,
			contentType: media.contentType,
			byteSize: media.byteSize,
			kind: media.kind,
			originalFilename: media.originalFilename,
			deletedAt: media.deletedAt,
			purgedAt: media.purgedAt,
		})
		.from(media)
		.where(and(eq(media.id, mediaId), eq(media.userId, userId)))
		.get();
	return row ?? null;
}

/**
 * Images whose size was never probed and whose bytes still exist (live or in
 * the trash), oldest first — the backfill's queue. Across all users: a
 * background job, not a request path. `after` resumes past a row the caller
 * has already seen, so a row it had to leave NULL doesn't come back first in
 * every batch.
 */
export function listImagesNeedingDimensions(
	limit: number,
	after?: { createdAt: number; id: string },
): Array<{ id: string; storagePath: string; createdAt: number }> {
	return getDb()
		.select({ id: media.id, storagePath: media.storagePath, createdAt: media.createdAt })
		.from(media)
		.where(
			and(
				eq(media.kind, 'image'),
				isNull(media.width),
				isNull(media.purgedAt),
				after
					? or(
							gt(media.createdAt, after.createdAt),
							and(eq(media.createdAt, after.createdAt), gt(media.id, after.id)),
						)
					: undefined,
			),
		)
		.orderBy(asc(media.createdAt), asc(media.id))
		.limit(limit)
		.all();
}

/** Record a probed size. Only fills a row still unprobed, so it can't
 *  overwrite a size an insert recorded. */
export function setMediaDimensions(id: string, dims: ImageDimensions): boolean {
	return (
		getDb()
			.update(media)
			.set({ width: dims.width, height: dims.height })
			.where(and(eq(media.id, id), isNull(media.width)))
			.run().changes > 0
	);
}

/**
 * Fill `width` / `height` on image parts that lack them, from their media rows,
 * in one batched lookup. A part generated since the columns existed carries its
 * size already; this covers older parts and uploads, whose part is written
 * before anything measured the file. Mutates in place.
 *
 * For client-bound reads only — the upstream serializer maps parts field by
 * field and would pay for a query it then ignores. `userId` is the messages'
 * owner, and scopes the media read: a part only ever names its own owner's
 * media today, but this is a read of a user-owned table, so it says so itself
 * rather than leaning on that.
 */
export function attachImageDimensions(
	msgs: ReadonlyArray<{ parts: MessagePart[] }>,
	userId: string,
): void {
	const missing = new Set<string>();
	for (const m of msgs) {
		for (const p of m.parts) {
			if (p.type === 'image' && p.width === undefined) missing.add(p.mediaId);
		}
	}
	if (missing.size === 0) return;
	const rows = getDb()
		.select({ id: media.id, width: media.width, height: media.height })
		.from(media)
		.where(and(inArray(media.id, [...missing]), eq(media.userId, userId)))
		.all();
	const byId = new Map(rows.map((r) => [r.id, storedDimensions(r.width, r.height)]));
	for (const m of msgs) {
		for (const p of m.parts) {
			if (p.type !== 'image' || p.width !== undefined) continue;
			const dims = byId.get(p.mediaId);
			if (dims) {
				p.width = dims.width;
				p.height = dims.height;
			}
		}
	}
}
