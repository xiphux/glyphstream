/**
 * What a gallery item is and which media the gallery may show: the shared
 * projection, visibility rule and kind filter, and the per-item finishing
 * (favorite flag, conversation title). Used by the gallery, search and trash
 * queries; not re-exported from the `media.ts` barrel except the two names
 * callers outside used before the split.
 */
import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { getDb } from '../../client';
import { conversations, media } from '../../schema';

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
export const assignedConversationId = sql<
	string | null
>`(SELECT m2.conversation_id FROM message_media mm JOIN messages m2 ON m2.id = mm.message_id JOIN conversations c2 ON c2.id = m2.conversation_id AND c2.user_id = media.user_id WHERE mm.media_id = media.id ORDER BY m2.created_at ASC, m2.id ASC LIMIT 1)`;

/**
 * `media.width` / `media.height` as the wire carries them: NULL both for "never
 * probed" and for the 0 × 0 "probed, unreadable" marker (see
 * `media/dimensions.ts`), so a client never sizes a box to nothing.
 */
export const MEDIA_DIMENSIONS_SELECT = {
	width: sql<number | null>`NULLIF(${media.width}, 0)`,
	height: sql<number | null>`NULLIF(${media.height}, 0)`,
};

/**
 * The columns a gallery item is built from (`MediaListItem`, before the favorite
 * flag and conversation title are attached). Shared by every query that
 * returns gallery items, so they can't disagree on what an item carries.
 */
export const GALLERY_ITEM_SELECT = {
	id: media.id,
	kind: media.kind,
	contentType: media.contentType,
	byteSize: media.byteSize,
	sourceEndpointId: media.sourceEndpointId,
	sourceModel: media.sourceModel,
	promptExcerpt: media.promptExcerpt,
	promptFull: media.promptFull,
	originalPrompt: media.originalPrompt,
	aspectRatio: media.aspectRatio,
	...MEDIA_DIMENSIONS_SELECT,
	createdAt: media.createdAt,
	origin: media.origin,
	favoritedAt: media.favoritedAt,
	conversationId: assignedConversationId,
};

/**
 * What the gallery shows of a user's media: their own, not in the trash, and
 * generated. User-supplied attachments live in the same table for ref-counting
 * but are not the gallery's ("what the AI made"). Callers add a kind filter.
 */
export function galleryVisibility(userId: string): SQL[] {
	return [eq(media.userId, userId), isNull(media.deletedAt), eq(media.origin, 'generated')];
}

/** One kind, or the gallery's default of image and video — never `file`. */
export function galleryKind(kind: 'image' | 'video' | undefined): SQL {
	return kind ? eq(media.kind, kind) : inArray(media.kind, ['image', 'video']);
}

/**
 * `favorited_at` is a nullable timestamp in the DB and a plain `favorite`
 * boolean on the wire (no surface needs the moment of starring yet).
 *
 * Converted in TS rather than projected as ``sql<boolean>`… is not null` ``:
 * SQLite has no boolean type and hands back 0/1, so the `sql<boolean>` form
 * only *claims* a boolean while shipping a number — `JSON.stringify` would put
 * `"favorite": 0` on the wire under a type that says otherwise, and every
 * consumer would keep type-checking. Dropping `favoritedAt` from the returned
 * row keeps the DB column out of the DTO.
 */
export function withFavoriteFlag<T extends { favoritedAt: number | null }>(
	row: T,
): Omit<T, 'favoritedAt'> & { favorite: boolean } {
	const { favoritedAt, ...rest } = row;
	return { ...rest, favorite: favoritedAt != null };
}

/**
 * Resolve `{ conversationId -> title }` for a set of items (scoped to the
 * user), then stamp `conversationTitle` onto each. One batched lookup rather
 * than a row-multiplying JOIN or a nested title subquery. Mutates and returns
 * the same array for convenience.
 */
export function attachConversationTitles<
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
