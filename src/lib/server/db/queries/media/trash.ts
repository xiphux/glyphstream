/**
 * "Recently deleted": moving generated media to the trash, listing it,
 * restoring it, and purging it for good. Expiry of old trash is the purger's
 * (`maintenance.ts`).
 */
import { and, desc, eq, inArray, isNotNull, isNull, lte } from 'drizzle-orm';
import { getDb } from '../../client';
import { media, messageMedia } from '../../schema';
import type { TrashedMediaItem } from '#lib/types/api.js';
import { withFavoriteFlag } from './shape';

/**
 * Move one media row to the trash *now*, regardless of refs. Returns false on
 * not-found / ownership mismatch / already-deleted.
 *
 * Old messages that referenced this media continue to render an `<img>` tag
 * pointing at /api/media/{id}/content, which 404s once `deletedAt` is set,
 * so the user sees a broken-image placeholder — and the image again if it is
 * restored. Acceptable trade-off — the alternative (rewriting message
 * content_json to drop the part) requires walking many rows for each delete.
 */
export function trashMediaForUser(mediaId: string, userId: string): boolean {
	return bulkTrashMediaForUser([mediaId], userId).length > 0;
}

/**
 * Bulk variant of trashMediaForUser — one transaction for the whole selection.
 * Filters to the caller's own rows that aren't already deleted (a single foreign
 * or tombstoned id in the list doesn't poison the rest), then stamps them and
 * drops their join rows in batched statements. Returns the ids actually
 * trashed; ids passed in but excluded from the result are silently dropped,
 * matching the single-id endpoint's idempotency shape. Empty input → empty
 * output, no transaction.
 */
export function bulkTrashMediaForUser(ids: readonly string[], userId: string): string[] {
	if (ids.length === 0) return [];
	const db = getDb();
	return db.transaction((tx) => {
		const liveIds = tx
			.select({ id: media.id })
			.from(media)
			.where(
				and(eq(media.userId, userId), inArray(media.id, ids as string[]), isNull(media.deletedAt)),
			)
			.all()
			.map((r) => r.id);
		if (liveIds.length === 0) return [];
		const now = Date.now();
		tx.update(media)
			.set({ deletedAt: now, refCount: 0, unreferencedSince: now })
			.where(inArray(media.id, liveIds))
			.run();
		// Drop join rows so the messages no longer carry a stale link in their
		// per-message media list (ON DELETE CASCADE on the FK would do this if the
		// media row were deleted, but the row is kept for the trash and then as a
		// tombstone).
		tx.delete(messageMedia).where(inArray(messageMedia.mediaId, liveIds)).run();
		return liveIds;
	});
}

/**
 * The user's "Recently deleted": generated images and videos in the trash,
 * most recently deleted first. `kind: 'file'` and uploads can sit in the trash
 * too (a conversation delete takes a generated CSV with it; a direct API call
 * can trash an upload) but are left out, matching the gallery they'd be
 * restored into — they simply age out on the same clock.
 *
 * Unpaginated: the trash is bounded by the retention window, and the partial
 * `idx_media_trash` index holds nothing else. The cap is a backstop against a
 * month of bulk deletes, not a page size.
 */
export function listTrashForUser(userId: string, limit = 1000): TrashedMediaRow[] {
	const rows = getDb()
		.select({
			id: media.id,
			kind: media.kind,
			contentType: media.contentType,
			byteSize: media.byteSize,
			sourceEndpointId: media.sourceEndpointId,
			sourceModel: media.sourceModel,
			promptExcerpt: media.promptExcerpt,
			originalPrompt: media.originalPrompt,
			aspectRatio: media.aspectRatio,
			createdAt: media.createdAt,
			origin: media.origin,
			favoritedAt: media.favoritedAt,
			deletedAt: media.deletedAt,
		})
		.from(media)
		.where(
			and(
				eq(media.userId, userId),
				isNotNull(media.deletedAt),
				isNull(media.purgedAt),
				eq(media.origin, 'generated'),
				inArray(media.kind, ['image', 'video']),
			),
		)
		.orderBy(desc(media.deletedAt), desc(media.id))
		.limit(limit)
		.all();
	// The WHERE pins `kind` to image/video and `deletedAt` non-null; the select's
	// types can't see that. No conversation join: a delete dropped the links.
	// `promptFull` isn't selected: it runs to thousands of characters, and the
	// only things that read it (regenerate, use as starting image) are withheld
	// on a trashed item — the viewer shows the excerpt. Restore puts it back
	// within reach.
	return rows.map((r) => ({
		...withFavoriteFlag(r),
		kind: r.kind as 'image' | 'video',
		deletedAt: r.deletedAt!,
		promptFull: null,
		conversationId: null,
		conversationTitle: null,
	}));
}

export type TrashedMediaRow = Omit<TrashedMediaItem, 'expiresAt'>;

/**
 * Put trashed rows back in the library. Only the caller's own generated rows
 * that are deleted-but-not-purged qualify; anything else in `ids` is silently
 * dropped. Returns the ids restored.
 *
 * `unreferenced_since` and the zeroed `ref_count` are left as the delete set
 * them: a generated row is never reaped for being unreferenced, so they are
 * inert, and they're accurate — nothing links to it any more.
 */
export function restoreMediaForUser(ids: readonly string[], userId: string): string[] {
	if (ids.length === 0) return [];
	return getDb().transaction((tx) => {
		const restorable = tx
			.select({ id: media.id })
			.from(media)
			.where(
				and(
					eq(media.userId, userId),
					inArray(media.id, ids as string[]),
					isNotNull(media.deletedAt),
					isNull(media.purgedAt),
					eq(media.origin, 'generated'),
				),
			)
			.all()
			.map((r) => r.id);
		if (restorable.length === 0) return [];
		tx.update(media).set({ deletedAt: null }).where(inArray(media.id, restorable)).run();
		return restorable;
	});
}

/**
 * "Delete forever" from the trash: stamp `purged_at` on the caller's trashed
 * rows and return their storage paths for the caller to unlink AFTER this
 * commits (see `unlinkMediaFiles`). One `UPDATE … RETURNING`, so the rows
 * stamped are exactly the rows returned.
 *
 * `{ deletedUpTo }` is "Empty": everything deleted at or before that moment —
 * the newest deletion the page was showing. Not "everything in the trash right
 * now": a branch or fan-out delete in another tab can land while the page sits
 * open, and an unconfirmed delete is the case the trash exists for, so Empty
 * must not take something the user never saw. It does take anything past the
 * list's cap (older than what was shown), and the file/upload rows
 * `listTrashForUser` doesn't list that were deleted by then — one deleted
 * after the newest item shown (say, a CSV-only conversation) stays and simply
 * ages out with the rest.
 */
export function purgeTrashForUser(
	which: readonly string[] | { deletedUpTo: number },
	userId: string,
): Array<{ id: string; storagePath: string }> {
	let scope;
	if ('deletedUpTo' in which) scope = lte(media.deletedAt, which.deletedUpTo);
	else if (which.length > 0) scope = inArray(media.id, [...which]);
	else return [];
	return getDb()
		.update(media)
		.set({ purgedAt: Date.now() })
		.where(and(eq(media.userId, userId), isNotNull(media.deletedAt), isNull(media.purgedAt), scope))
		.returning({ id: media.id, storagePath: media.storagePath })
		.all();
}

// --- Per-conversation orphan analysis (drives the delete-conversation UI) ---
