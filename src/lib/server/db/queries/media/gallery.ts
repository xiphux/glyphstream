/**
 * The gallery's per-item reads and the one write it makes (starring): items by
 * id, the model facet, a conversation's media, and the conversations a media
 * item appears in. The feed itself is `gallery/layout.ts`. Every query here
 * returns gallery items through `GALLERY_ITEM_SELECT` and shows only what
 * `galleryVisibility` allows.
 */
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { getDb } from '../../client';
import { conversations, media, messageMedia, messages } from '../../schema';
import { bestEffort, recordMediaEvent } from '#lib/server/stats/model-stats.js';
import type {
	ConversationMediaRef,
	MediaConversationRef,
	MediaListItem,
	ModelFacet,
} from '#lib/types/api.js';
import {
	assignedConversationId,
	attachConversationTitles,
	GALLERY_ITEM_SELECT,
	galleryKind,
	galleryVisibility,
	MEDIA_DIMENSIONS_SELECT,
	withFavoriteFlag,
} from './shape';

/**
 * Fetch a single media row in the MediaListItem shape (the same fields
 * the gallery's list query returns). Used by the chat-side lightbox to
 * populate model + prompt metadata that isn't in the message's
 * `content_json` — message parts only carry the media id. Returns null
 * when the row doesn't exist, is deleted (trashed or purged), or belongs to a
 * different user.
 */
export function getMediaListItemForUser(mediaId: string, userId: string): MediaListItem | null {
	const db = getDb();
	const row = db
		.select(GALLERY_ITEM_SELECT)
		.from(media)
		.where(and(eq(media.id, mediaId), eq(media.userId, userId), isNull(media.deletedAt)))
		.get();
	if (!row) return null;
	return attachConversationTitles(userId, [
		{ ...withFavoriteFlag(row), conversationTitle: null },
	])[0];
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
			...MEDIA_DIMENSIONS_SELECT,
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
				isNull(media.deletedAt),
			),
		)
		.orderBy(asc(media.createdAt), asc(media.id))
		.all()
		.map(({ id, kind, width, height }) => ({ id, kind, width, height }));
}

/** Fetch `MediaListItem`s for a set of ids (scoped + visible), titles attached.
 *  Unordered — the caller re-orders. Used to materialize semantic-only hits. */
export function getMediaListItemsByIds(userId: string, ids: string[]): MediaListItem[] {
	if (ids.length === 0) return [];
	const rows = getDb()
		.select(GALLERY_ITEM_SELECT)
		.from(media)
		.where(and(...galleryVisibility(userId), inArray(media.id, ids)))
		.all();
	return attachConversationTitles(
		userId,
		rows.map((r) => ({ ...withFavoriteFlag(r), conversationTitle: null })),
	);
}

/**
 * Distinct `source_model` values across a user's gallery media, with counts —
 * the option list for the gallery's Model facet dropdown. Scoped to the same
 * set the gallery shows (generated, non-deleted, image/video), and excludes
 * NULL-model rows (legacy / not-applicable). Optionally narrowed by `kind` so
 * the video view lists only models that produced videos; deliberately *not*
 * narrowed by any active model selection, so the dropdown stays switchable.
 * Ordered most-used-first.
 *
 * `favorite` narrows it the same way `kind` does: with Favorites on, the Model
 * dropdown lists only models that made something starred, with counts among the
 * starred set — so the numbers match the grid the user is looking at instead of
 * offering a model whose favorites-filtered result is empty.
 */
export function listDistinctSourceModelsForUser(
	userId: string,
	opts: { kind?: 'image' | 'video'; favorite?: boolean } = {},
): ModelFacet[] {
	const db = getDb();
	const conditions = [
		...galleryVisibility(userId),
		isNotNull(media.sourceModel),
		galleryKind(opts.kind),
		opts.favorite ? isNotNull(media.favoritedAt) : undefined,
	].filter(Boolean) as Array<Parameters<typeof and>[number]>;

	const rows = db
		.select({ value: media.sourceModel, count: sql<number>`count(*)`.mapWith(Number) })
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
 * loaded all of it from the demand-loaded unit feed. This is the authoritative
 * "give me the whole stack" read used when a user drills into a conversation
 * card.
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
	opts: {
		kind?: 'image' | 'video';
		model?: string;
		/** Mirrors the gallery's Favorites filter so drilling into a stack shows the
		 *  same members the collapsed card counted, not the unfiltered bucket. */
		favorite?: boolean;
	} = {},
): MediaListItem[] {
	const db = getDb();

	// Media linked to any message in this conversation — the candidate set the
	// per-row `assignedConversationId` subquery then runs over.
	const linkedToConversation = db
		.select({ id: messageMedia.mediaId })
		.from(messageMedia)
		.innerJoin(messages, eq(messages.id, messageMedia.messageId))
		.where(eq(messages.conversationId, conversationId));

	const rows = db
		.select(GALLERY_ITEM_SELECT)
		.from(media)
		.where(
			and(
				...galleryVisibility(userId),
				galleryKind(opts.kind),
				opts.model ? eq(media.sourceModel, opts.model) : undefined,
				opts.favorite ? isNotNull(media.favoritedAt) : undefined,
				inArray(media.id, linkedToConversation),
				sql`${assignedConversationId} = ${conversationId}`,
			),
		)
		.orderBy(desc(media.createdAt), desc(media.id))
		.all();

	return attachConversationTitles(
		userId,
		rows.map((r) => ({ ...withFavoriteFlag(r), conversationTitle: null })),
	);
}

// --- Reverse lookup: which conversations reference this media -------------

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

// --- Favorites (gallery / lightbox star) ---------------------------------

/**
 * Last `favorited_at` this process wrote, so the next star is guaranteed a
 * strictly greater one.
 *
 * `Date.now()` alone is not enough, and the gap is not theoretical — a test
 * caught it. `galleryUserFingerprint` detects a favorite change from
 * `(count, max(favorited_at))`, and unstarring one row while starring another
 * leaves the count where it was; if both writes land in the same millisecond the
 * max is unchanged too, so the gallery's memo serves the old starred set.
 * Nudging the stamp forward makes any star move the max, with no extra work in
 * the read path (the alternative was folding row identity into an aggregate that
 * runs on every gallery request).
 *
 * A process-local counter is sound because this is a single-Node deployment by
 * design — and the caches it keeps honest are in-process anyway, so anything that
 * broke this assumption would already have broken them. Worst case the stored
 * instant runs a few ms ahead of the wall clock; its only reader is
 * `galleryUserFingerprint`'s `max()`, which cares that the value MOVED rather than
 * what it says, and no surface shows it to a user. The counter restarts at 0 with
 * the process, so a star after a restart could in principle repeat a stamp an
 * earlier process wrote — that needs the clock to have gone backwards, and the
 * cache TTL (`GALLERY_UNITS_TTL_MS`) is the backstop if it ever did.
 */
let lastFavoritedAt = 0;

/**
 * Star / unstar one media row. Returns false on not-found, ownership mismatch,
 * or an already-tombstoned row, which the endpoint turns into a 404.
 *
 * Idempotent by value, not by write: starring an already-starred row overwrites
 * `favorited_at` with a fresh, strictly-increasing stamp (see `lastFavoritedAt`).
 * That's wanted — the stamp is what makes a toggle visible to
 * `galleryUserFingerprint`, so an idempotent no-op write would leave the
 * gallery's caches convinced nothing changed.
 *
 * No FTS bookkeeping: the `media_prompt_fts` triggers fire on insert, delete,
 * and `AFTER UPDATE OF prompt_full` specifically, so this write doesn't touch
 * the index.
 */
export function setMediaFavorite(mediaId: string, userId: string, favorite: boolean): boolean {
	// Read before writing so the stats count a transition, not a repeated toggle
	// (re-starring a starred row still writes — see above).
	const before = bestEffort('favorite', () =>
		getDb()
			.select({ favoritedAt: media.favoritedAt })
			.from(media)
			.where(and(eq(media.id, mediaId), eq(media.userId, userId)))
			.get(),
	);
	let stamp: number | null = null;
	if (favorite) {
		stamp = Math.max(Date.now(), lastFavoritedAt + 1);
		lastFavoritedAt = stamp;
	}
	const res = getDb()
		.update(media)
		.set({ favoritedAt: stamp })
		.where(
			and(
				eq(media.id, mediaId),
				eq(media.userId, userId),
				isNull(media.deletedAt),
				// Generated only, matching the set the gallery actually lists. A star
				// means "keep this AND let me find it again", and the gallery filters
				// uploads out everywhere — so starring an upload would be a button
				// whose second half can never be honoured. The chat lightbox (the one
				// surface that shows uploads) withholds the star for the same reason;
				// this is the server-side half of that contract.
				eq(media.origin, 'generated'),
			),
		)
		.run();
	const changed = res.changes > 0;
	if (changed && before && (before.favoritedAt !== null) !== favorite) {
		recordMediaEvent([mediaId], favorite ? 'favorited' : 'unfavorited');
	}
	return changed;
}
