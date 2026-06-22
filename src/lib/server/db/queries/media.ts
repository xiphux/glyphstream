import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { generateId } from '../../util/id';
import { getDb, type Tx } from '../client';
import { conversations, media, messageMedia, messages } from '../schema';

/** Union of valid `media.kind` values. 'file' covers anything that
 *  isn't natively image/video (xlsx, csv, pdf, json, txt, ...) — used
 *  for user attachments and code-interpreter outputs. */
export type MediaKind = 'image' | 'video' | 'file';

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
			originalFilename: input.originalFilename ?? null,
			createdAt: now,
			refCount: 0,
			// Uploads start in the "candidate for purge" state — if the user
			// picks a file but never sends the message, the existing purger
			// will sweep it after the grace period. linkMessageMedia clears
			// this back to null when the file actually gets attached.
			unreferencedSince: origin === 'uploaded' ? now : null,
			hardDeletedAt: null,
		})
		.run();
	return { id };
}

/** Link a media asset to a message and bump ref_count. Idempotent (PK on the join). */
export function linkMessageMedia(messageId: string, mediaId: string): void {
	const db = getDb();
	db.transaction((tx) => {
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
	});
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
	hardDeletedAt: number | null;
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
			hardDeletedAt: media.hardDeletedAt,
		})
		.from(media)
		.where(and(eq(media.id, mediaId), eq(media.userId, userId)))
		.get();
	return row ?? null;
}

/**
 * Fetch a single media row in the MediaListItem shape (the same fields
 * the gallery's list query returns). Used by the chat-side lightbox to
 * populate model + prompt metadata that isn't in the message's
 * `content_json` — message parts only carry the media id. Returns null
 * when the row doesn't exist, is hard-deleted, or belongs to a
 * different user.
 */
export function getMediaListItemForUser(mediaId: string, userId: string): MediaListItem | null {
	const db = getDb();
	const row = db
		.select({
			id: media.id,
			kind: media.kind,
			contentType: media.contentType,
			byteSize: media.byteSize,
			sourceEndpointId: media.sourceEndpointId,
			sourceModel: media.sourceModel,
			promptExcerpt: media.promptExcerpt,
			promptFull: media.promptFull,
			createdAt: media.createdAt,
			conversationId: assignedConversationId,
		})
		.from(media)
		.where(and(eq(media.id, mediaId), eq(media.userId, userId), isNull(media.hardDeletedAt)))
		.get();
	if (!row) return null;
	return attachConversationTitles(userId, [{ ...row, conversationTitle: null }])[0];
}

export interface ConversationMediaRef {
	id: string;
	kind: MediaKind;
}

/**
 * All image/video media referenced anywhere in a conversation, oldest
 * first — the navigation set for the in-chat lightbox carousel.
 *
 * Deliberately spans the *whole tree*, not just the active branch:
 * multi-image batches, multi-model fan-out grids, and regenerate/follow-up
 * revisions are all stored as sibling branches, only one of which sits on
 * the active leaf path. Scoping to the active path (as the message-parts
 * list does) would surface just one image per generation point and defeat
 * the carousel. Joining through message_media → messages picks up every
 * branch's media regardless of which leaf is currently active.
 *
 * Ownership is enforced via the conversations.user_id join, so a foreign
 * or unknown conversation id returns `[]`. `selectDistinct` collapses a
 * media row referenced by more than one message (e.g. a starting image
 * reused downstream) to a single carousel entry.
 */
export function listConversationMediaRefs(
	conversationId: string,
	userId: string,
): ConversationMediaRef[] {
	const db = getDb();
	return db
		.selectDistinct({
			id: media.id,
			kind: media.kind,
			createdAt: media.createdAt,
		})
		.from(messageMedia)
		.innerJoin(messages, eq(messages.id, messageMedia.messageId))
		.innerJoin(conversations, eq(conversations.id, messages.conversationId))
		.innerJoin(media, eq(media.id, messageMedia.mediaId))
		.where(
			and(
				eq(messages.conversationId, conversationId),
				eq(conversations.userId, userId),
				inArray(media.kind, ['image', 'video']),
				isNull(media.hardDeletedAt),
			),
		)
		.orderBy(asc(media.createdAt), asc(media.id))
		.all()
		.map(({ id, kind }) => ({ id, kind }));
}

// --- Gallery listing -----------------------------------------------------

export interface MediaListItem {
	id: string;
	kind: MediaKind;
	contentType: string;
	byteSize: number;
	sourceEndpointId: string | null;
	sourceModel: string | null;
	/** Truncated preview for caption-strip / thumbnail surfaces. */
	promptExcerpt: string | null;
	/** Full prompt for "Regenerate with this prompt" / inspect flows.
	 *  May equal `promptExcerpt` for legacy rows; equals the original
	 *  untruncated prompt for anything generated post-migration. */
	promptFull: string | null;
	createdAt: number;
	/** Conversation this asset is assigned to for gallery stacking — the
	 *  earliest message that references it. Null for orphan media whose
	 *  conversation was deleted (its message_media join rows cascaded away).
	 *  Media can be referenced from several conversations; we pick one
	 *  deterministically so grouping is stable. */
	conversationId: string | null;
	/** Title of `conversationId` (null when untitled or orphaned). */
	conversationTitle: string | null;
}

/**
 * Scalar subquery: the conversation of the *earliest* message referencing a
 * media row — the deterministic owner used for gallery stacking. NULL when no
 * message references it (orphan media kept after its conversation was deleted).
 * Physical table/column names are used directly. The correlation references the
 * outer row as the literal `media.id` / `media.user_id` rather than
 * interpolating `${media.id}` — drizzle renders that column unqualified as
 * `"id"`, which the subquery would resolve to `messages.id` instead of the
 * outer media row.
 *
 * The `conversations c2` join with `c2.user_id = media.user_id` keeps this from
 * being an unscoped read of a user-owned table (the multi-user isolation
 * invariant): a media row is only ever assigned a conversation owned by the
 * same user, matching how the sibling queries (listConversationsForMedia,
 * listConversationMediaRefs) join + scope. Today every link site re-validates
 * media ownership, so the assignment can't cross users — but enforcing it at
 * the read survives a future cross-user sharing/forking feature.
 */
const assignedConversationId = sql<
	string | null
>`(SELECT m2.conversation_id FROM message_media mm JOIN messages m2 ON m2.id = mm.message_id JOIN conversations c2 ON c2.id = m2.conversation_id AND c2.user_id = media.user_id WHERE mm.media_id = media.id ORDER BY m2.created_at ASC, m2.id ASC LIMIT 1)`;

/**
 * Resolve `{ conversationId -> title }` for a set of items (scoped to the
 * user), then stamp `conversationTitle` onto each. One batched lookup rather
 * than a row-multiplying JOIN or a nested title subquery. Mutates and returns
 * the same array for convenience.
 */
function attachConversationTitles<
	T extends { conversationId: string | null; conversationTitle?: string | null },
>(userId: string, items: T[]): T[] {
	const ids = [...new Set(items.map((i) => i.conversationId).filter((id): id is string => !!id))];
	if (ids.length === 0) {
		for (const i of items) i.conversationTitle = null;
		return items;
	}
	const rows = getDb()
		.select({ id: conversations.id, title: conversations.title })
		.from(conversations)
		.where(and(inArray(conversations.id, ids), eq(conversations.userId, userId)))
		.all();
	const titleById = new Map(rows.map((r) => [r.id, r.title]));
	for (const i of items) {
		i.conversationTitle = i.conversationId ? (titleById.get(i.conversationId) ?? null) : null;
	}
	return items;
}

export interface MediaListResult {
	items: MediaListItem[];
	/** Pass back as `cursor` to fetch the next page; null when no more. */
	nextCursor: string | null;
}

/**
 * List a user's non-deleted media for the gallery, newest first.
 *
 * Cursor format: `${createdAt}:${id}` — composite to break ties when two
 * rows land in the same millisecond. We page using `(createdAt, id)
 * lexicographic compare` rather than OFFSET so insertion-during-paging
 * doesn't shift items and OFFSET cost doesn't grow with depth.
 */
export function listMediaForUser(
	userId: string,
	opts: {
		kind?: 'image' | 'video';
		/**
		 * Explicit kinds-allowlist. When omitted, defaults to
		 * `['image', 'video']` so file-kind rows never leak into the
		 * gallery UI; explicit callers (admin tooling, future browse-
		 * by-conversation surfaces) can pass `['image', 'video', 'file']`
		 * if they want the full set. Mutually exclusive with `kind`
		 * (which is a single-value convenience for the gallery's
		 * `?kind=image` / `?kind=video` filter param).
		 */
		kinds?: readonly MediaKind[];
		/**
		 * Faceted filter: restrict to media generated by this exact
		 * `source_model` (the raw upstream id, as stored). ANDs with `kind`.
		 * Facet values come from `listDistinctSourceModelsForUser`.
		 */
		model?: string;
		cursor?: string | null;
		limit?: number;
	} = {},
): MediaListResult {
	const db = getDb();
	const limit = Math.max(1, Math.min(opts.limit ?? 60, 200));

	// `<` on (createdAt, id) — newer rows have larger createdAt; we want
	// "older than the cursor". Composite key: (createdAt < cur) OR
	// (createdAt = cur AND id < cur_id).
	const cursorWhere = (() => {
		if (!opts.cursor) return undefined;
		const [cAt, cId] = opts.cursor.split(':');
		const at = Number.parseInt(cAt, 10);
		if (!Number.isFinite(at) || !cId) return undefined;
		return or(lt(media.createdAt, at), and(eq(media.createdAt, at), lt(media.id, cId)));
	})();

	// Default to image+video only. Adding `kind: 'file'` to the schema
	// means an unfiltered `listMediaForUser` would suddenly surface
	// xlsx/pdf attachments in the gallery; pin the default so that
	// change to the schema is silent and explicit at every call site
	// that wants the wider set.
	const allowedKinds: readonly MediaKind[] = opts.kind
		? [opts.kind]
		: (opts.kinds ?? ['image', 'video']);

	const conditions = [
		eq(media.userId, userId),
		isNull(media.hardDeletedAt),
		// Gallery is "what the AI made" — exclude user-supplied attachments
		// even though they live in the same table for ref-counting reasons.
		eq(media.origin, 'generated'),
		allowedKinds.length === 1
			? eq(media.kind, allowedKinds[0])
			: inArray(media.kind, allowedKinds as MediaKind[]),
		opts.model ? eq(media.sourceModel, opts.model) : undefined,
		cursorWhere,
	].filter(Boolean) as Parameters<typeof and>[number][];

	// Fetch limit+1 to detect whether there's another page.
	const rows = db
		.select({
			id: media.id,
			kind: media.kind,
			contentType: media.contentType,
			byteSize: media.byteSize,
			sourceEndpointId: media.sourceEndpointId,
			sourceModel: media.sourceModel,
			promptExcerpt: media.promptExcerpt,
			promptFull: media.promptFull,
			createdAt: media.createdAt,
			conversationId: assignedConversationId,
		})
		.from(media)
		.where(and(...conditions))
		.orderBy(desc(media.createdAt), desc(media.id))
		.limit(limit + 1)
		.all();

	const hasMore = rows.length > limit;
	const sliced = hasMore ? rows.slice(0, limit) : rows;
	const last = sliced[sliced.length - 1];
	const nextCursor = hasMore && last ? `${last.createdAt}:${last.id}` : null;
	const items: MediaListItem[] = attachConversationTitles(
		userId,
		sliced.map((r) => ({ ...r, conversationTitle: null })),
	);
	return { items, nextCursor };
}

export interface ModelFacet {
	/** The raw `source_model` value, used as the `?model=` filter key. */
	value: string;
	/** How many of the user's gallery items were generated by this model. */
	count: number;
}

/**
 * Distinct `source_model` values across a user's gallery media, with counts —
 * the option list for the gallery's Model facet dropdown. Scoped to the same
 * set the gallery shows (generated, non-deleted, image/video), and excludes
 * NULL-model rows (legacy / not-applicable). Optionally narrowed by `kind` so
 * the video view lists only models that produced videos; deliberately *not*
 * narrowed by any active model selection, so the dropdown stays switchable.
 * Ordered most-used-first.
 */
export function listDistinctSourceModelsForUser(
	userId: string,
	opts: { kind?: 'image' | 'video' } = {},
): ModelFacet[] {
	const db = getDb();
	const conditions = [
		eq(media.userId, userId),
		isNull(media.hardDeletedAt),
		eq(media.origin, 'generated'),
		isNotNull(media.sourceModel),
		opts.kind ? eq(media.kind, opts.kind) : inArray(media.kind, ['image', 'video']),
	].filter(Boolean) as Parameters<typeof and>[number][];

	const rows = db
		.select({ value: media.sourceModel, count: sql<number>`count(*)` })
		.from(media)
		.where(and(...conditions))
		.groupBy(media.sourceModel)
		.orderBy(sql`count(*) desc`)
		.all();

	// `sourceModel` is non-null here (isNotNull filter), so the cast is safe.
	return rows.map((r) => ({ value: r.value as string, count: r.count }));
}

/**
 * Every gallery item *assigned* to a conversation, newest-first — the complete
 * member set of one gallery stack. The gallery groups by `assignedConversationId`
 * (the earliest-referencing message's conversation); a conversation's media is
 * not contiguous in the time-ordered stream, so the client can't be sure it has
 * loaded all of it from the paginated `listMediaForUser` feed. This is the
 * authoritative "give me the whole stack" read used when a user drills into a
 * conversation card.
 *
 * Filtered to exactly the same set the top-level bucket would contain:
 *   - linked to this conversation (the `inArray` prefilter narrows the
 *     correlated-subquery work to a handful of rows), AND
 *   - whose *assigned* conversation is this one — so a media reused across
 *     conversations still belongs to a single stack (its earliest), never two.
 * Ownership is enforced by `media.user_id = userId` plus the user-scoped
 * `assignedConversationId` join, so a foreign/unknown id returns `[]`.
 */
export function listMediaForConversation(
	conversationId: string,
	userId: string,
	opts: { kind?: 'image' | 'video'; kinds?: readonly MediaKind[] } = {},
): MediaListItem[] {
	const db = getDb();
	const allowedKinds: readonly MediaKind[] = opts.kind
		? [opts.kind]
		: (opts.kinds ?? ['image', 'video']);

	// Media linked to any message in this conversation — the candidate set the
	// per-row `assignedConversationId` subquery then runs over.
	const linkedToConversation = db
		.select({ id: messageMedia.mediaId })
		.from(messageMedia)
		.innerJoin(messages, eq(messages.id, messageMedia.messageId))
		.where(eq(messages.conversationId, conversationId));

	const rows = db
		.select({
			id: media.id,
			kind: media.kind,
			contentType: media.contentType,
			byteSize: media.byteSize,
			sourceEndpointId: media.sourceEndpointId,
			sourceModel: media.sourceModel,
			promptExcerpt: media.promptExcerpt,
			promptFull: media.promptFull,
			createdAt: media.createdAt,
			conversationId: assignedConversationId,
		})
		.from(media)
		.where(
			and(
				eq(media.userId, userId),
				isNull(media.hardDeletedAt),
				eq(media.origin, 'generated'),
				allowedKinds.length === 1
					? eq(media.kind, allowedKinds[0])
					: inArray(media.kind, allowedKinds as MediaKind[]),
				inArray(media.id, linkedToConversation),
				sql`${assignedConversationId} = ${conversationId}`,
			),
		)
		.orderBy(desc(media.createdAt), desc(media.id))
		.all();

	return attachConversationTitles(
		userId,
		rows.map((r) => ({ ...r, conversationTitle: null })),
	);
}

// --- Reverse lookup: which conversations reference this media -------------

export interface MediaConversationRef {
	id: string;
	title: string | null;
	updatedAt: number;
	archivedAt: number | null;
}

/**
 * Conversations that reference `mediaId`, deduped (a single media can be
 * linked to multiple messages within one conversation — e.g. across retry
 * siblings — and we only want the conversation listed once).
 *
 * Filtered by `conversations.user_id = userId` for ownership: even if a
 * caller passes a media id they don't own, the join clause naturally
 * excludes other users' conversations. Returns `[]` for a non-existent
 * or foreign media id, indistinguishable from the legitimate "this media
 * isn't used anywhere" case — which is the right shape for the gallery
 * lightbox: 0-result is the cleanup signal we want to surface.
 */
export function listConversationsForMedia(mediaId: string, userId: string): MediaConversationRef[] {
	const db = getDb();
	return db
		.selectDistinct({
			id: conversations.id,
			title: conversations.title,
			updatedAt: conversations.updatedAt,
			archivedAt: conversations.archivedAt,
		})
		.from(messageMedia)
		.innerJoin(messages, eq(messages.id, messageMedia.messageId))
		.innerJoin(conversations, eq(conversations.id, messages.conversationId))
		.where(and(eq(messageMedia.mediaId, mediaId), eq(conversations.userId, userId)))
		.orderBy(desc(conversations.updatedAt))
		.all();
}

// --- Manual hard-delete (gallery "delete this") --------------------------

/**
 * Mark a media row hard-deleted *now*, regardless of refs. Returns the
 * storage path so the caller can unlink the file from disk. Returns null
 * on not-found / ownership mismatch / already-deleted.
 *
 * Old messages that referenced this media will continue to render an `<img>`
 * tag pointing at /api/media/{id}/content; the content endpoint already
 * returns 404 once `hardDeletedAt` is set, so the user sees a broken-image
 * placeholder. Acceptable v1 trade-off — the alternative (rewriting message
 * content_json to drop the part) requires walking many rows for each delete.
 */
export function hardDeleteMediaForUser(
	mediaId: string,
	userId: string,
): { storagePath: string } | null {
	const db = getDb();
	return db.transaction((tx) => {
		const row = tx
			.select({ storagePath: media.storagePath, hardDeletedAt: media.hardDeletedAt })
			.from(media)
			.where(and(eq(media.id, mediaId), eq(media.userId, userId)))
			.get();
		if (!row || row.hardDeletedAt !== null) return null;

		tx.update(media)
			.set({ hardDeletedAt: Date.now(), refCount: 0, unreferencedSince: Date.now() })
			.where(eq(media.id, mediaId))
			.run();
		// Drop join rows so the messages no longer carry a stale link in
		// their per-message media list (cheap; ON DELETE CASCADE on the FK
		// would do this if the media row were deleted, but we keep the
		// row as a tombstone for the historical record).
		tx.delete(messageMedia).where(eq(messageMedia.mediaId, mediaId)).run();
		return { storagePath: row.storagePath };
	});
}

/**
 * Bulk variant of hardDeleteMediaForUser — one transaction for the whole
 * selection. Filters to the caller's own rows that aren't already hard-
 * deleted (a single foreign or tombstoned id in the list doesn't poison
 * the rest), then marks them tombstoned and drops their join rows in
 * batched statements. Returns the `{id, storagePath}` pairs the caller
 * should unlink from disk; ids passed in but excluded from the result
 * are silently dropped, matching the single-id endpoint's idempotency
 * shape. Empty input → empty output, no transaction.
 */
export function bulkHardDeleteMediaForUser(
	ids: readonly string[],
	userId: string,
): { id: string; storagePath: string }[] {
	if (ids.length === 0) return [];
	const db = getDb();
	return db.transaction((tx) => {
		const rows = tx
			.select({ id: media.id, storagePath: media.storagePath })
			.from(media)
			.where(
				and(
					eq(media.userId, userId),
					inArray(media.id, ids as string[]),
					isNull(media.hardDeletedAt),
				),
			)
			.all();
		if (rows.length === 0) return [];
		const liveIds = rows.map((r) => r.id);
		const now = Date.now();
		tx.update(media)
			.set({ hardDeletedAt: now, refCount: 0, unreferencedSince: now })
			.where(inArray(media.id, liveIds))
			.run();
		tx.delete(messageMedia).where(inArray(messageMedia.mediaId, liveIds)).run();
		return rows;
	});
}

// --- Per-conversation orphan analysis (drives the delete-conversation UI) ---

export interface ConversationOrphanCounts {
	images: number;
	videos: number;
}

/**
 * Given message↔media join rows (already scoped to one user), return the
 * set of media ids that would orphan if those rows' messages were
 * deleted: every reference to the media lives inside the row set, it's
 * generated (not uploaded), and it isn't already hard-deleted.
 *
 * The orphan rule — count how many of a media's references appear in the
 * row set and compare to its total `ref_count`; equal means deleting the
 * set drops ref_count to zero. The same media can appear on multiple
 * rows (linked from several messages via the auto-attach-last-generated
 * flow); those collapse to one orphan. Shared by the delete-conversation
 * pre-flight count and the actual orphan hard-delete so the two cannot
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
		hardDeletedAt: number | null;
	}>,
): Set<string> {
	const localCount = new Map<string, number>();
	const meta = new Map<
		string,
		{ refCount: number; origin: 'generated' | 'uploaded'; hardDeletedAt: number | null }
	>();
	for (const r of rows) {
		localCount.set(r.mediaId, (localCount.get(r.mediaId) ?? 0) + 1);
		if (!meta.has(r.mediaId)) {
			meta.set(r.mediaId, {
				refCount: r.refCount,
				origin: r.origin,
				hardDeletedAt: r.hardDeletedAt,
			});
		}
	}
	const orphans = new Set<string>();
	for (const [mediaId, count] of localCount) {
		const m = meta.get(mediaId)!;
		if (m.hardDeletedAt !== null) continue;
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
			hardDeletedAt: media.hardDeletedAt,
		})
		.from(messageMedia)
		.innerJoin(messages, eq(messages.id, messageMedia.messageId))
		.innerJoin(media, eq(media.id, messageMedia.mediaId))
		.where(and(eq(messages.conversationId, conversationId), eq(media.userId, userId)))
		.all();

	const orphans = collectOrphanGeneratedMediaIds(rows);

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
 * Identify generated media that would orphan as a result of deleting
 * the given set of messages, and immediately mark them hard-deleted.
 * Returns the storage paths so the caller can unlink the files from
 * disk outside the DB transaction.
 *
 * Callers:
 *   - `deleteConversation` (with the full set of message ids for the
 *     conversation, gated by the user's "Also delete media" checkbox).
 *   - `deleteBranch` (with the BFS-collected subtree being removed —
 *     no user gate; branch-delete is always "I rejected this variant"
 *     so its uniquely-attached media should always go).
 *
 * Must be called BEFORE `decrementMediaForMessages` so the `refCount`
 * comparison reflects the pre-decrement state. After this returns,
 * the regular decrement path takes over for the remaining (still-
 * referenced) media — that's the only path through which non-orphan
 * rows get their ref_count adjusted.
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
export function hardDeleteOrphanGeneratedMediaForMessages(
	tx: Tx,
	messageIds: string[],
	userId: string,
): Array<{ id: string; storagePath: string }> {
	if (messageIds.length === 0) return [];

	const rows = tx
		.select({
			mediaId: messageMedia.mediaId,
			storagePath: media.storagePath,
			refCount: media.refCount,
			origin: media.origin,
			hardDeletedAt: media.hardDeletedAt,
		})
		.from(messageMedia)
		.innerJoin(media, eq(media.id, messageMedia.mediaId))
		.where(and(inArray(messageMedia.messageId, messageIds), eq(media.userId, userId)))
		.all();

	const orphans = collectOrphanGeneratedMediaIds(rows);

	// First-seen storage path per media, for the unlink list.
	const pathOf = new Map<string, string>();
	for (const r of rows) {
		if (!pathOf.has(r.mediaId)) pathOf.set(r.mediaId, r.storagePath);
	}
	const now = Date.now();
	const toUnlink: Array<{ id: string; storagePath: string }> = [];
	for (const mediaId of orphans) {
		tx.update(media).set({ hardDeletedAt: now }).where(eq(media.id, mediaId)).run();
		toUnlink.push({ id: mediaId, storagePath: pathOf.get(mediaId)! });
	}
	return toUnlink;
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
 * `hardDeleteOrphanGeneratedMediaForMessages`.
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
 * delete "also delete media" checkbox, branch-delete) hard-delete it.
 * The purger's sole remaining job is reaping uploads the user picked
 * but never sent.
 *
 * Deliberately NOT user-scoped: this (and `markHardDeleted` /
 * `stampOrphanedZeroRefRows`) are trusted background-maintenance queries
 * run by the purger over the whole media table, not request-driven paths.
 * A user_id predicate here would be wrong — the purger sweeps every user.
 */
export function findPurgeCandidates(olderThanMs: number, limit = 500): PurgeCandidate[] {
	const db = getDb();
	return db
		.select({ id: media.id, storagePath: media.storagePath })
		.from(media)
		.where(
			and(
				isNull(media.hardDeletedAt),
				isNotNull(media.unreferencedSince),
				lte(media.unreferencedSince, olderThanMs),
				eq(media.origin, 'uploaded'),
			),
		)
		.orderBy(asc(media.unreferencedSince))
		.limit(limit)
		.all();
}

/** Mark a media row hard-deleted (post file unlink). */
export function markHardDeleted(mediaId: string): void {
	const db = getDb();
	db.update(media).set({ hardDeletedAt: Date.now() }).where(eq(media.id, mediaId)).run();
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
				isNull(media.hardDeletedAt),
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
