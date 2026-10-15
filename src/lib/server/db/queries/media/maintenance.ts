/**
 * Keeping the table honest: what deleting a conversation orphans, ref-count
 * decrements when messages go, and the purger's claims on abandoned uploads
 * and expired trash.
 */
import { and, asc, eq, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { getDb, type Tx } from '../../client';
import { conversations, media, messageMedia, messages } from '../../schema';
import type { MediaKind, ConversationOrphanCounts } from '#lib/types/api.js';

/**
 * Given message↔media join rows (already scoped to one user), return the
 * set of media ids that would orphan if those rows' messages were
 * deleted: every reference to the media lives inside the row set, it's
 * generated (not uploaded), and it isn't already deleted (trashed or purged).
 *
 * The orphan rule — count how many of a media's references appear in the
 * row set and compare to its total `ref_count`; equal means deleting the
 * set drops ref_count to zero. The same media can appear on multiple
 * rows (linked from several messages via the auto-attach-last-generated
 * flow); those collapse to one orphan. Shared by the delete-conversation
 * pre-flight count and the actual orphan trash pass so the two cannot
 * disagree on what "orphan" means.
 *
 * Exported (despite being an internal of this module) so its orphan rule
 * can be unit-tested directly rather than only through the DB-backed
 * count/delete paths.
 */
export function collectOrphanGeneratedMediaIds(
	rows: ReadonlyArray<{
		mediaId: string;
		refCount: number;
		origin: 'generated' | 'uploaded';
		deletedAt: number | null;
	}>,
): Set<string> {
	const localCount = new Map<string, number>();
	const meta = new Map<
		string,
		{ refCount: number; origin: 'generated' | 'uploaded'; deletedAt: number | null }
	>();
	for (const r of rows) {
		localCount.set(r.mediaId, (localCount.get(r.mediaId) ?? 0) + 1);
		if (!meta.has(r.mediaId)) {
			meta.set(r.mediaId, {
				refCount: r.refCount,
				origin: r.origin,
				deletedAt: r.deletedAt,
			});
		}
	}
	const orphans = new Set<string>();
	for (const [mediaId, count] of localCount) {
		const m = meta.get(mediaId)!;
		if (m.deletedAt !== null) continue;
		if (m.origin !== 'generated') continue;
		if (m.refCount !== count) continue;
		orphans.add(mediaId);
	}
	return orphans;
}

/**
 * Count generated media that would become orphaned if this conversation
 * were deleted — i.e. media whose only references are inside this
 * conversation. Used by the delete-conversation confirm dialog to show
 * the user how many gallery items they could optionally purge along
 * with the conversation.
 *
 * Scope: only counts `origin='generated'` media. Uploaded media is
 * always transient under the library model — the purger handles it
 * on its own schedule, so it's not part of the user's decision.
 */
export function countOrphanMediaInConversation(
	conversationId: string,
	userId: string,
): ConversationOrphanCounts {
	const db = getDb();
	const rows = db
		.select({
			mediaId: messageMedia.mediaId,
			kind: media.kind,
			refCount: media.refCount,
			origin: media.origin,
			deletedAt: media.deletedAt,
		})
		.from(messageMedia)
		.innerJoin(messages, eq(messages.id, messageMedia.messageId))
		.innerJoin(media, eq(media.id, messageMedia.mediaId))
		.where(and(eq(messages.conversationId, conversationId), eq(media.userId, userId)))
		.all();

	// A conversation's own avatar holds a reference that deleting the
	// conversation RELEASES — `deleteConversation` unlinks it before this same
	// orphan rule runs. Model that release here or the two disagree: a portrait
	// drawn in this conversation reads as shared (so the dialog offers to delete
	// one fewer than it will), and in the avatar-only case the dialog offers
	// nothing at all while the delete would still have taken it. Deducting the
	// pending release makes the number the dialog shows the number the delete
	// removes.
	const avatar = db
		.select({ mediaId: conversations.avatarMediaId })
		.from(conversations)
		.where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
		.get();
	const adjusted = avatar?.mediaId
		? rows.map((r) => (r.mediaId === avatar.mediaId ? { ...r, refCount: r.refCount - 1 } : r))
		: rows;

	const orphans = collectOrphanGeneratedMediaIds(adjusted);

	// First-seen kind per media, to split the orphan set into image/video.
	// `kind: 'file'` rows (xlsx, csv, code-interpreter outputs, ...) are
	// deliberately excluded from the count — the delete-conversation modal
	// surfaces "X images, Y videos" as visual library housekeeping, and
	// file attachments don't share that mental model. They still get
	// orphan-reaped via the normal cascade; the user just isn't prompted
	// about them. Revisit if users start asking "where did my generated
	// CSVs go after I deleted that chat."
	const kindOf = new Map<string, MediaKind>();
	for (const r of rows) {
		if (!kindOf.has(r.mediaId)) kindOf.set(r.mediaId, r.kind);
	}
	let images = 0;
	let videos = 0;
	for (const mediaId of orphans) {
		const k = kindOf.get(mediaId);
		if (k === 'image') images++;
		else if (k === 'video') videos++;
		// kind === 'file': intentionally not counted; see comment above.
	}
	return { images, videos };
}

/**
 * Identify generated media that would orphan as a result of deleting the given
 * set of messages, and move them to the trash (see `./trash`).
 * Returns the ids trashed.
 *
 * Callers:
 *   - `deleteConversation` (with the full set of message ids for the
 *     conversation, gated by the user's "Also delete media" checkbox).
 *   - `deleteBranch` (with the BFS-collected subtree being removed —
 *     no user gate; branch-delete is always "I rejected this variant"
 *     so its uniquely-attached media should always go). That ungated,
 *     unconfirmed delete is the main reason the trash exists.
 *
 * Must be called BEFORE `decrementMediaForMessages` so the `refCount`
 * comparison reflects the pre-decrement state. After this returns,
 * the regular decrement path takes over for the remaining (still-
 * referenced) media — that's the only path through which non-orphan
 * rows get their ref_count adjusted. The trashed rows' own join rows are
 * left for that decrement and the message cascade to clear, as before.
 *
 * Scope: generated media only — uploaded media follows the purger's
 * own auto-sweep path and is not affected by user-driven "also
 * delete media" on conversation delete or by branch-delete.
 *
 * Runs on the caller's transaction (`tx`): both call sites invoke it
 * inside their own `db.transaction()`, so it participates in that atomic
 * unit. (node:sqlite, unlike better-sqlite3, won't auto-promote a nested
 * root-level `db.transaction()` to a SAVEPOINT.)
 */
export function trashOrphanGeneratedMediaForMessages(
	tx: Tx,
	messageIds: string[],
	userId: string,
): string[] {
	if (messageIds.length === 0) return [];

	const rows = tx
		.select({
			mediaId: messageMedia.mediaId,
			refCount: media.refCount,
			origin: media.origin,
			deletedAt: media.deletedAt,
		})
		.from(messageMedia)
		.innerJoin(media, eq(media.id, messageMedia.mediaId))
		.where(and(inArray(messageMedia.messageId, messageIds), eq(media.userId, userId)))
		.all();

	const orphans = [...collectOrphanGeneratedMediaIds(rows)];
	if (orphans.length === 0) return [];
	tx.update(media).set({ deletedAt: Date.now() }).where(inArray(media.id, orphans)).run();
	return orphans;
}

// --- Cascade-delete cleanup ----------------------------------------------

/**
 * Decrement ref_count for every media row referenced by any of `messageIds`,
 * setting `unreferenced_since = now` for any row that drops to zero. Call
 * this BEFORE deleting messages — the schema's ON DELETE CASCADE on
 * `message_media` would otherwise drop the join rows silently and leave
 * `media.ref_count` permanently inflated.
 *
 * Implemented as one CTE-style update per affected media id rather than a
 * single `ref_count -= COUNT(*)` query because we also need to set
 * `unreferenced_since` when the count crosses zero, which is awkward to
 * express in a single SQL statement on SQLite.
 *
 * Runs on the caller's transaction (`tx`) — see the note on
 * `trashOrphanGeneratedMediaForMessages`.
 */
export function decrementMediaForMessages(tx: Tx, messageIds: string[]): void {
	if (messageIds.length === 0) return;
	const links = tx
		.select({ mediaId: messageMedia.mediaId })
		.from(messageMedia)
		.where(inArray(messageMedia.messageId, messageIds))
		.all();
	if (links.length === 0) return;

	// Tally per-media decrements (a single message can reference the
	// same media id at most once thanks to the (message_id, media_id) PK,
	// but a media id can appear across multiple messages).
	const decBy = new Map<string, number>();
	for (const { mediaId } of links) {
		decBy.set(mediaId, (decBy.get(mediaId) ?? 0) + 1);
	}

	const now = Date.now();
	for (const [mediaId, dec] of decBy) {
		// Clamp at zero to be defensive — we shouldn't ever go negative,
		// but if we did the purger would never fire on the row.
		tx.update(media)
			.set({
				refCount: sql`MAX(${media.refCount} - ${dec}, 0)`,
				unreferencedSince: sql`CASE WHEN MAX(${media.refCount} - ${dec}, 0) = 0 THEN ${now} ELSE ${media.unreferencedSince} END`,
			})
			.where(eq(media.id, mediaId))
			.run();
	}
}

/** All message ids belonging to a conversation — used by deleteConversation. */
export function listMessageIdsForConversation(conversationId: string): string[] {
	const db = getDb();
	return db
		.select({ id: messages.id })
		.from(messages)
		.where(eq(messages.conversationId, conversationId))
		.all()
		.map((r) => r.id);
}

// --- Sweeper queries -----------------------------------------------------

export interface PurgeCandidate {
	id: string;
	storagePath: string;
}

/**
 * Uploaded-and-abandoned media rows whose grace period has elapsed.
 *
 * Scope note: generated media (origin='generated') is never returned by
 * this query. Under the library model it persists indefinitely once
 * produced — only explicit user actions (gallery delete, conversation-
 * delete "also delete media" checkbox, branch-delete) delete it, and those
 * go through the trash, which the purger expires via `claimExpiredTrash`.
 * This query's job is reaping uploads the user picked but never sent.
 *
 * Deliberately NOT user-scoped: this (and `claimAbandonedUploads` /
 * `stampOrphanedZeroRefRows`) are trusted background-maintenance queries
 * run by the purger over the whole media table, not request-driven paths.
 * A user_id predicate here would be wrong — the purger sweeps every user.
 */
export function findPurgeCandidates(
	olderThanMs: number,
	limit = 500,
	reader: Tx | ReturnType<typeof getDb> = getDb(),
): PurgeCandidate[] {
	return reader
		.select({ id: media.id, storagePath: media.storagePath })
		.from(media)
		.where(
			and(
				isNull(media.deletedAt),
				isNotNull(media.unreferencedSince),
				lte(media.unreferencedSince, olderThanMs),
				eq(media.origin, 'uploaded'),
				// Favorites are never swept. Defensive rather than load-bearing
				// today: `setMediaFavorite` only stars generated rows and this query
				// only reaps uploaded ones, so the two sets can't currently overlap.
				// It's here because this is the predicate a bulk-cleanup sweep would
				// grow from (ROADMAP's favorite/pin tier), and the cost of stating
				// the invariant once is one `AND` on an already-indexed query.
				isNull(media.favoritedAt),
			),
		)
		.orderBy(asc(media.unreferencedSince))
		.limit(limit)
		.all();
}

/**
 * Claim abandoned uploads for deletion: in one synchronous transaction, select
 * what `findPurgeCandidates` would return and stamp it deleted AND purged (an
 * upload never passes through the trash), returning the storage paths for the
 * caller to unlink AFTER this commits.
 *
 * Claim-then-unlink, like `claimExpiredTrash`. The purger used to unlink first
 * and mark afterwards, and during that awaited unlink the row still read as
 * live: a message attaching it right then linked it (clearing nothing the mark
 * looked at), and the mark then tombstoned a row a message now referenced, with
 * no file behind it — every later send of that conversation failed on it. Now
 * an attach lands either before the claim (the link clears
 * `unreferenced_since`, so the row no longer qualifies) or after it (it sees a
 * deleted row and is refused). A failed unlink leaks the file instead of
 * being retried — the same trade `claimExpiredTrash` makes.
 */
export function claimAbandonedUploads(olderThanMs: number, limit = 500): PurgeCandidate[] {
	return getDb().transaction((tx) => {
		const rows = findPurgeCandidates(olderThanMs, limit, tx);
		if (rows.length === 0) return [];
		const now = Date.now();
		tx.update(media)
			.set({ deletedAt: now, purgedAt: now })
			.where(
				inArray(
					media.id,
					rows.map((r) => r.id),
				),
			)
			.run();
		return rows;
	});
}

/**
 * Claim trashed rows whose retention has run out (`deleted_at <= olderThanMs`),
 * oldest first: stamp `purged_at` and return their storage paths for the caller
 * to unlink AFTER this commits. Every user, every origin and kind — same
 * trusted-maintenance scoping as `findPurgeCandidates`. Served by the partial
 * `idx_media_trash`, which holds only the trash.
 *
 * Claim-then-unlink, like the upload phase, and here it matters more: a
 * trashed row can be RESTORED. Marking after an awaited unlink left a window
 * in which a restore cleared `deleted_at`, the unlink took the bytes anyway,
 * and the row came back to the gallery as a permanently broken tile. Here the
 * select and the stamp are one synchronous transaction, so a restore lands
 * either before (the row no longer matches and is skipped) or after (it sees
 * `purged_at` and refuses). The cost is the same as `purgeTrashForUser`'s: a
 * failed unlink leaks the file rather than being retried.
 */
export function claimExpiredTrash(olderThanMs: number, limit = 500): PurgeCandidate[] {
	return getDb().transaction((tx) => {
		const rows = tx
			.select({ id: media.id, storagePath: media.storagePath })
			.from(media)
			.where(
				and(isNotNull(media.deletedAt), isNull(media.purgedAt), lte(media.deletedAt, olderThanMs)),
			)
			.orderBy(asc(media.deletedAt))
			.limit(limit)
			.all();
		if (rows.length === 0) return [];
		tx.update(media)
			.set({ purgedAt: Date.now() })
			.where(
				inArray(
					media.id,
					rows.map((r) => r.id),
				),
			)
			.run();
		return rows;
	});
}

/**
 * Defensive sweep: zero-ref-count uploaded rows that lack
 * `unreferenced_since` (e.g. because a server crash happened between
 * insertMedia and linkMessageMedia) get stamped now so the next purge
 * cycle can collect them. Scoped to origin='uploaded' so any zero-ref
 * *generated* rows that get into this state (which shouldn't happen
 * under normal operation, but could from a future edge case or a
 * partial migration) stay parked rather than getting reaped against
 * the library-model contract. Idempotent.
 */
export function stampOrphanedZeroRefRows(): number {
	const db = getDb();
	const r = db
		.update(media)
		.set({ unreferencedSince: Date.now() })
		.where(
			and(
				isNull(media.deletedAt),
				isNull(media.unreferencedSince),
				eq(media.refCount, 0),
				eq(media.origin, 'uploaded'),
			),
		)
		.run();
	// node:sqlite types `changes` as `number | bigint`; affected-row counts
	// are always within safe-integer range, so narrowing to number is safe.
	return Number(r.changes);
}
