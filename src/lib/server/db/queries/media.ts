import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import { generateId } from '../../util/id';
import { getDb, type Tx } from '../client';
import { conversations, media, messageMedia, messages } from '../schema';
import { buildFtsQuery } from './search';
import { DEFAULT_GALLERY_SEARCH_MIN_SIMILARITY } from '../../endpoints/config';
import { resolveRelevanceConfig } from '../../retrieval/embeddings-config';
import { embedQuery } from '../../retrieval/embed-rank';
import { cosineRank, decodeVector } from '../../retrieval/vector';
import { fuseRankings } from '../../retrieval/fusion';
import { groupGalleryItems, type StackableMedia } from '../../../gallery-stacks';

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
	/** The user's pre-enhancement prompt, when the enhancer rewrote it before
	 *  generation (`promptFull`/`promptExcerpt` then hold the ENHANCED prompt).
	 *  Null when no enhancement happened or for uploads. */
	originalPrompt?: string | null;
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
			originalPrompt: media.originalPrompt,
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
	 *  untruncated prompt for anything generated post-migration. When the
	 *  prompt was enhanced, this is the ENHANCED prompt (what generated the
	 *  image); see `originalPrompt` for the user's text. */
	promptFull: string | null;
	/** The user's pre-enhancement prompt, when the image-prompt enhancer
	 *  rewrote it. Null when no enhancement happened. Lets the UI surface
	 *  "Enhanced — show original". */
	originalPrompt: string | null;
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
		/**
		 * Quick-jump seek anchor: only rows strictly older than this instant
		 * (epoch ms). Used to re-anchor the gallery feed at a chosen month
		 * without a cursor; composes with the cursor for subsequent pages.
		 */
		before?: number;
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
		opts.before != null ? lt(media.createdAt, opts.before) : undefined,
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
			originalPrompt: media.originalPrompt,
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

/** Max relevance-ranked results a single prompt search returns. No pagination —
 *  refine the query if the top N isn't enough (cf. `searchConversations`). */
const MEDIA_SEARCH_CAP = 150;
/** Max stored prompt vectors the dense leg scans per query (bounds cosine/IO at
 *  household scale; the most-recent rows win past it). */
const DENSE_CORPUS_CAP = 5000;
/** Semantic neighbours the dense leg contributes to the fusion. Bounded so a
 *  query returns keyword hits + a modest set of synonym matches, not the whole
 *  ranked corpus. */
const DENSE_TOPK = 100;

type SearchOpts = { kind?: 'image' | 'video'; model?: string; limit?: number };

/** Keyword leg: bm25-ranked FTS5 hits as full `MediaListItem`s (titles attached). */
function ftsRankMedia(
	userId: string,
	match: string,
	opts: SearchOpts,
	limit: number,
): MediaListItem[] {
	const kindCond = opts.kind
		? sql`AND media.kind = ${opts.kind}`
		: sql`AND media.kind IN ('image', 'video')`;
	const modelCond = opts.model ? sql`AND media.source_model = ${opts.model}` : sql``;

	// Raw SQL: drizzle doesn't model FTS5 virtual tables, and bm25()/MATCH must
	// share one SELECT. Params are bound (no injection). The media table keeps
	// its real name so the `assignedConversationId` fragment's `media.*`
	// correlation resolves to the outer row.
	const rows = getDb().all<{
		id: string;
		kind: MediaKind;
		content_type: string;
		byte_size: number;
		source_endpoint_id: string | null;
		source_model: string | null;
		prompt_excerpt: string | null;
		prompt_full: string | null;
		original_prompt: string | null;
		created_at: number;
		conversation_id: string | null;
	}>(sql`
		SELECT
			media.id AS id,
			media.kind AS kind,
			media.content_type AS content_type,
			media.byte_size AS byte_size,
			media.source_endpoint_id AS source_endpoint_id,
			media.source_model AS source_model,
			media.prompt_excerpt AS prompt_excerpt,
			media.prompt_full AS prompt_full,
			media.original_prompt AS original_prompt,
			media.created_at AS created_at,
			${assignedConversationId} AS conversation_id
		FROM media_prompt_fts f
		JOIN media ON media.id = f.media_id
		WHERE f.user_id = ${userId}
			AND media_prompt_fts MATCH ${match}
			AND media.hard_deleted_at IS NULL
			AND media.origin = 'generated'
			${kindCond}
			${modelCond}
		ORDER BY bm25(media_prompt_fts) ASC
		LIMIT ${limit}
	`);

	return attachConversationTitles(
		userId,
		rows.map((r) => ({
			id: r.id,
			kind: r.kind,
			contentType: r.content_type,
			byteSize: r.byte_size,
			sourceEndpointId: r.source_endpoint_id,
			sourceModel: r.source_model,
			promptExcerpt: r.prompt_excerpt,
			promptFull: r.prompt_full,
			originalPrompt: r.original_prompt,
			createdAt: r.created_at,
			conversationId: r.conversation_id,
			conversationTitle: null,
		})),
	);
}

/** Fetch `MediaListItem`s for a set of ids (scoped + visible), titles attached.
 *  Unordered — the caller re-orders. Used to materialize semantic-only hits. */
function getMediaListItemsByIds(userId: string, ids: string[]): MediaListItem[] {
	if (ids.length === 0) return [];
	const rows = getDb()
		.select({
			id: media.id,
			kind: media.kind,
			contentType: media.contentType,
			byteSize: media.byteSize,
			sourceEndpointId: media.sourceEndpointId,
			sourceModel: media.sourceModel,
			promptExcerpt: media.promptExcerpt,
			promptFull: media.promptFull,
			originalPrompt: media.originalPrompt,
			createdAt: media.createdAt,
			conversationId: assignedConversationId,
		})
		.from(media)
		.where(
			and(
				eq(media.userId, userId),
				isNull(media.hardDeletedAt),
				eq(media.origin, 'generated'),
				inArray(media.id, ids),
			),
		)
		.all();
	return attachConversationTitles(
		userId,
		rows.map((r) => ({ ...r, conversationTitle: null })),
	);
}

/**
 * Relevance-ranked prompt search over a user's gallery media. Keyword leg: the
 * `media_prompt_fts` FTS5 index (migration 20260622120000), ranked by bm25.
 * When an `[embeddings]` endpoint is configured, a semantic leg (cosine over
 * stored `prompt_full` vectors) fuses in via RRF, surfacing synonym matches the
 * keyword leg misses; it degrades to keyword-only on any failure (no config,
 * endpoint down) — same as memory recall. Returns up to {@link MEDIA_SEARCH_CAP}
 * `MediaListItem`s best-match-first, no cursor (a ranked mode, not the browse).
 *
 * Visibility (hard_deleted / origin) + kind/model compose on both legs. A dense
 * neighbour must clear the configurable cosine floor
 * (`gallery_search_min_similarity`, default 0.5) to surface, so noise doesn't pad
 * the results — which means an embeddings-on query with no keyword hit and no
 * above-floor neighbour can also return empty, same as keyword-only mode.
 */
export async function searchMediaForUser(
	userId: string,
	rawQuery: string,
	opts: SearchOpts = {},
): Promise<MediaListItem[]> {
	const match = buildFtsQuery(rawQuery);
	if (!match) return [];
	const limit = Math.max(1, Math.min(opts.limit ?? MEDIA_SEARCH_CAP, MEDIA_SEARCH_CAP));

	const ftsItems = ftsRankMedia(userId, match, opts, MEDIA_SEARCH_CAP);

	const cfg = resolveRelevanceConfig();
	if (!cfg) return ftsItems.slice(0, limit);

	// The whole dense leg degrades to keyword-only on any failure — not just the
	// embed call: a corrupt/truncated stored blob or a provider silently changing
	// a model's output dimension would make cosineRank→dot throw, and there's no
	// gallery +error.svelte to catch a 500. Mirrors denseRank in tools/memory.ts.
	try {
		const qvec = await embedQuery(rawQuery, cfg, AbortSignal.timeout(cfg.timeoutSeconds * 1000));
		if (!qvec) return ftsItems.slice(0, limit);

		const vecRows = listMediaEmbeddingsForUser(userId, {
			kind: opts.kind,
			model: opts.model,
			embeddingModel: cfg.modelId,
			limit: DENSE_CORPUS_CAP,
		});
		if (vecRows.length === 0) return ftsItems.slice(0, limit);

		// Apply a cosine floor BEFORE taking the top-K: cosineRank ranks the whole
		// loaded candidate set (up to DENSE_CORPUS_CAP), so without a floor the
		// dense leg pads results with arbitrary nearest-neighbours (unrelated
		// prompts) — only genuine synonyms should surface. Threshold is
		// config-tunable (model-dependent cosine scales).
		const minSim = cfg.gallerySearchMinSimilarity ?? DEFAULT_GALLERY_SEARCH_MIN_SIMILARITY;
		const denseRanked = cosineRank(
			qvec,
			vecRows.map((r) => decodeVector(r.embedding)),
		)
			.filter((sc) => sc.score >= minSim)
			.slice(0, DENSE_TOPK);
		const denseIds = denseRanked.map((sc) => vecRows[sc.index].id);

		// Fuse the two rankings over a shared id→index space (RRF ignores scores,
		// uses rank position). The union includes semantic-only ids, so synonym
		// matches surface; keyword hits get an extra contribution and rank higher.
		const ftsIds = ftsItems.map((i) => i.id);
		const idList = [...new Set([...ftsIds, ...denseIds])];
		const idxOf = new Map(idList.map((id, i) => [id, i]));
		const ftsRanking = ftsIds.map((id) => ({ index: idxOf.get(id)!, score: 0 }));
		const denseRanking = denseIds.map((id) => ({ index: idxOf.get(id)!, score: 0 }));
		const orderedIds = fuseRankings([ftsRanking, denseRanking])
			.slice(0, limit)
			.map((sc) => idList[sc.index]);

		// Materialize: reuse the keyword rows we already have; fetch only the
		// semantic-only ids.
		const byId = new Map(ftsItems.map((i) => [i.id, i]));
		const missing = orderedIds.filter((id) => !byId.has(id));
		for (const it of getMediaListItemsByIds(userId, missing)) byId.set(it.id, it);
		return orderedIds.map((id) => byId.get(id)).filter((x): x is MediaListItem => !!x);
	} catch (e) {
		console.warn('[gallery-search] dense leg failed; keyword-only:', e);
		return ftsItems.slice(0, limit);
	}
}

/**
 * Backfill work queue: gallery prompts still needing an embedding (fresh, served
 * by the partial index `idx_media_unembedded`), topped up with rows embedded by a
 * superseded model. Mirrors `listMemoriesNeedingEmbedding` (two queries, not an
 * `OR`, so the partial index isn't defeated). Cross-user — a background job.
 */
export function listMediaNeedingEmbedding(
	model: string,
	limit: number,
): Array<{ id: string; promptFull: string }> {
	const db = getDb();
	const sel = { id: media.id, promptFull: media.promptFull };
	// Excludes soft-deleted media (hard_deleted_at set, prompt_full intact) so a
	// tombstoned-before-embedding row doesn't spend an embed call. Must stay in
	// lockstep with idx_media_unembedded's WHERE so the index serves this query.
	const embeddable = and(
		isNull(media.hardDeletedAt),
		isNotNull(media.promptFull),
		eq(media.origin, 'generated'),
	);
	const fresh = db
		.select(sel)
		.from(media)
		.where(and(isNull(media.embedding), embeddable))
		.limit(limit)
		.all();
	if (fresh.length >= limit) return fresh as Array<{ id: string; promptFull: string }>;
	const stale = db
		.select(sel)
		.from(media)
		.where(and(isNotNull(media.embedding), embeddable, ne(media.embeddingModel, model)))
		.limit(limit - fresh.length)
		.all();
	return [...fresh, ...stale] as Array<{ id: string; promptFull: string }>;
}

/**
 * Persist a computed prompt embedding. Keyed by id (background, cross-user) and
 * guarded on `expectedPrompt` so a concurrent prompt change can't get the old
 * text's vector written under it. Returns true iff a row matched.
 */
export function setMediaEmbedding(
	id: string,
	expectedPrompt: string,
	embedding: Buffer,
	embeddingModel: string,
): boolean {
	const result = getDb()
		.update(media)
		.set({ embedding, embeddingModel })
		.where(and(eq(media.id, id), eq(media.promptFull, expectedPrompt)))
		.run();
	return result.changes > 0;
}

/**
 * Candidate vectors for the semantic search leg: a user's embedded gallery media
 * for the active embedding model, newest-first, capped. Composes with kind/model.
 */
export function listMediaEmbeddingsForUser(
	userId: string,
	opts: { kind?: 'image' | 'video'; model?: string; embeddingModel: string; limit?: number },
): Array<{ id: string; embedding: Buffer }> {
	const limit = Math.max(1, Math.min(opts.limit ?? DENSE_CORPUS_CAP, 20000));
	const conditions = [
		eq(media.userId, userId),
		isNull(media.hardDeletedAt),
		eq(media.origin, 'generated'),
		isNotNull(media.embedding),
		eq(media.embeddingModel, opts.embeddingModel),
		opts.kind ? eq(media.kind, opts.kind) : inArray(media.kind, ['image', 'video']),
		opts.model ? eq(media.sourceModel, opts.model) : undefined,
	].filter(Boolean) as Parameters<typeof and>[number][];

	return getDb()
		.select({ id: media.id, embedding: media.embedding })
		.from(media)
		.where(and(...conditions))
		.orderBy(desc(media.createdAt), desc(media.id))
		.limit(limit)
		.all() as Array<{ id: string; embedding: Buffer }>;
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

export interface MonthPeriod {
	/** Local-time month bucket, `YYYY-MM`. */
	key: string;
	/** How many of the user's gallery items fall in this month. */
	count: number;
}

/**
 * The gallery's quick-jump timeline: every local-time month a user has gallery
 * media in, newest-first, with counts. Scoped to the same set the gallery shows
 * (generated, non-deleted, image/video), optionally narrowed by `kind`/`model`
 * to match active filters.
 *
 * Buckets in the viewer's local time by shifting the stored UTC ms by
 * `tzOffsetMinutes` (`-new Date().getTimezoneOffset()` from the client) before
 * `strftime`. A single current offset is applied to all historical rows, so a
 * row within ~1h of a month boundary in the other DST phase can land in the
 * adjacent month — cosmetic, affecting only this list's counts. The actual seek
 * boundary is computed client-side (`nextMonthStartMs`), so jumps stay correct.
 */
export function listMediaMonthPeriodsForUser(
	userId: string,
	opts: { kind?: 'image' | 'video'; model?: string; tzOffsetMinutes?: number } = {},
): MonthPeriod[] {
	const db = getDb();
	const offsetMin = Number.isFinite(opts.tzOffsetMinutes) ? (opts.tzOffsetMinutes as number) : 0;
	const offsetModifier = `${offsetMin >= 0 ? '+' : ''}${offsetMin} minutes`;
	const monthExpr = sql<string>`strftime('%Y-%m', ${media.createdAt} / 1000, 'unixepoch', ${offsetModifier})`;

	const conditions = [
		eq(media.userId, userId),
		isNull(media.hardDeletedAt),
		eq(media.origin, 'generated'),
		opts.kind ? eq(media.kind, opts.kind) : inArray(media.kind, ['image', 'video']),
		opts.model ? eq(media.sourceModel, opts.model) : undefined,
	].filter(Boolean) as Parameters<typeof and>[number][];

	return db
		.select({ key: monthExpr, count: sql<number>`count(*)` })
		.from(media)
		.where(and(...conditions))
		.groupBy(monthExpr)
		.orderBy(sql`${monthExpr} desc`)
		.all();
}

/**
 * A single top-level gallery unit — a stack (conversation bucket or same-prompt
 * run) or a solo tile — as the client's virtualized grid renders it. Thin by
 * design: the demand-paged grid streams these in for the visible range, so a
 * unit carries only what a tile / stack-card needs (ids for thumbnails, the
 * newest few members for the collage, the leader's caption), never full prompt
 * bodies.
 */
export interface GalleryUnit {
	/** Group identity — the conversation id, or `p:<leaderId>` for a prompt run. */
	key: string;
	/** Stack flavor; 'solo' renders a single tile. */
	groupKind: 'conversation' | 'prompt' | 'solo';
	/** Newest member — the tile shown for a solo, the card anchor for a stack. */
	leaderId: string;
	leaderKind: MediaKind;
	/** Leader's createdAt — the unit's position in the newest-first stream. */
	createdAt: number;
	/** Local-time day bucket (`YYYY-MM-DD`) of the leader, computed with the
	 *  caller's tz offset so it matches the layout counts exactly. */
	dayKey: string;
	/** Total members (drives the "N items" / "+N" affordances). */
	memberCount: number;
	/** Newest ≤4 members for the stack-card collage (solo: just the leader). */
	previews: { id: string; kind: MediaKind }[];
	/** Leader's truncated prompt for the caption overlay. */
	excerpt: string | null;
	/** Human label for a stack card: the conversation title, or the run's shared
	 *  original prompt. Empty for solos (they show `excerpt` instead). */
	label: string;
	conversationId: string | null;
	title: string | null;
}

export interface GalleryLayout {
	/** Per-day unit counts, newest-first. The client reserves exact scroll height
	 *  from these (aggregating days into months for month granularity) before any
	 *  unit data loads — the counts, not the loaded rows, size the grid. */
	days: { key: string; units: number }[];
	/** Total top-level units across the whole (filtered) library. */
	totalUnits: number;
}

type GalleryUnitOpts = {
	kind?: 'image' | 'video';
	model?: string;
	tzOffsetMinutes?: number;
	/** Whether to collapse related media into stacks (the gallery's default).
	 *  `false` = the "stacking off" firehose: every media row is its own solo
	 *  unit, so the unit count equals the media count. */
	stack?: boolean;
};

/** Lightweight row projection sufficient to run `groupGalleryItems` and build
 *  the thin `GalleryUnit`s. */
interface UnitSourceRow extends StackableMedia {
	kind: MediaKind;
	promptExcerpt: string | null;
}

/** Two-digit zero-pad for the local day key. */
function pad2(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

/** Local-time `YYYY-MM-DD` for an instant, shifting UTC by the viewer's offset
 *  (same single-offset approach as the periods query; the DST-boundary caveat is
 *  cosmetic and — because each unit carries this exact key and the client
 *  sections by it — never desyncs a section's reserved height from the units
 *  rendered into it). */
function localDayKey(ms: number, tzOffsetMin: number): string {
	const d = new Date(ms + tzOffsetMin * 60_000);
	return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Load the whole filtered gallery library as lightweight rows, newest-first —
 *  the input to the server-side stacking pass. Mirrors listMediaForUser's
 *  gallery filter (generated, non-deleted, image/video, kind/model), minus
 *  pagination. */
function loadGalleryUnitSource(userId: string, opts: GalleryUnitOpts): UnitSourceRow[] {
	const db = getDb();
	const conditions = [
		eq(media.userId, userId),
		isNull(media.hardDeletedAt),
		eq(media.origin, 'generated'),
		opts.kind ? eq(media.kind, opts.kind) : inArray(media.kind, ['image', 'video']),
		opts.model ? eq(media.sourceModel, opts.model) : undefined,
	].filter(Boolean) as Parameters<typeof and>[number][];

	const rows = db
		.select({
			id: media.id,
			kind: media.kind,
			createdAt: media.createdAt,
			originalPrompt: media.originalPrompt,
			promptFull: media.promptFull,
			promptExcerpt: media.promptExcerpt,
			conversationId: assignedConversationId,
		})
		.from(media)
		.where(and(...conditions))
		.orderBy(desc(media.createdAt), desc(media.id))
		.all();

	return attachConversationTitles(
		userId,
		rows.map((r) => ({ ...r, conversationTitle: null as string | null })),
	);
}

/** One media row → a solo unit (the "stacking off" firehose path). */
function unitFromRow(r: UnitSourceRow, tz: number): GalleryUnit {
	return {
		key: r.id,
		groupKind: 'solo',
		leaderId: r.id,
		leaderKind: r.kind,
		createdAt: r.createdAt,
		dayKey: localDayKey(r.createdAt, tz),
		memberCount: 1,
		previews: [{ id: r.id, kind: r.kind }],
		excerpt: r.promptExcerpt,
		label: '',
		conversationId: r.conversationId,
		title: r.conversationTitle,
	};
}

/** One stacking group → a thin unit (leader-anchored, newest few previews). */
function unitFromGroup(
	g: ReturnType<typeof groupGalleryItems<UnitSourceRow>>[number],
	tz: number,
): GalleryUnit {
	const leader = g.items[0];
	return {
		key: g.key,
		groupKind: g.kind,
		leaderId: leader.id,
		leaderKind: leader.kind,
		createdAt: leader.createdAt,
		dayKey: localDayKey(leader.createdAt, tz),
		memberCount: g.items.length,
		previews: g.items.slice(0, 4).map((m) => ({ id: m.id, kind: m.kind })),
		excerpt: leader.promptExcerpt,
		// Stack label: conversation title, or the run's shared ORIGINAL prompt
		// (not the leader's enhanced excerpt, which describes only one image).
		label:
			g.kind === 'conversation'
				? (g.title ?? 'Untitled chat')
				: (leader.originalPrompt ?? leader.promptExcerpt ?? 'Untitled'),
		conversationId: g.conversationId,
		title: g.title,
	};
}

/** Run the shared stacking pass over the whole library and shape each group into
 *  a thin `GalleryUnit`, newest-first. This is the single source of truth the
 *  client's grid renders — identical grouping to the client's own
 *  `groupGalleryItems`, since it IS that function. With `stack: false` every row
 *  is a solo unit instead (the firehose view). */
function computeGalleryUnits(userId: string, opts: GalleryUnitOpts): GalleryUnit[] {
	const tz = Number.isFinite(opts.tzOffsetMinutes) ? (opts.tzOffsetMinutes as number) : 0;
	const rows = loadGalleryUnitSource(userId, opts);
	if (opts.stack === false) return rows.map((r) => unitFromRow(r, tz));
	return groupGalleryItems(rows).map((g) => unitFromGroup(g, tz));
}

// --- Gallery unit-list cache -------------------------------------------------
// `computeGalleryUnits` loads + stacks the WHOLE filtered library, and the
// client's grid demand-pages it (one `/api/media/units` request per PAGE units).
// A full top-to-bottom scroll would otherwise re-run that O(library) pass once
// per page — O(library²) of work across the scroll. Memoize the computed list
// per (user, filter, tz) so all pages of one scroll — and the paired layout +
// first-units of a single reload — share one computation.
//
// Correctness: each entry is validated against a cheap per-user data fingerprint
// (a count of the user's generated media, live + total). Any insert or delete
// changes it, so the cache auto-invalidates on every write path — including
// direct DB writes that bypass the query layer (e.g. the e2e seed helpers) —
// with no manual invalidation calls to keep in sync. A short TTL backstops the
// residual case a count can't see (a link/unlink or conversation delete that
// re-homes stacking without changing the count).
//
// Bounded size: `model` and `tzOffsetMinutes` are part of the key and come from
// unvalidated query params, so key cardinality is client-controlled. The map is
// capped and evicts the oldest entry (insertion order) past the cap, so it can't
// grow without bound in the single long-running Node process.
const GALLERY_UNITS_TTL_MS = 30_000;
const GALLERY_UNITS_CACHE_MAX = 256;
const galleryUnitsCache = new Map<
	string,
	{ fingerprint: string; expiresAt: number; units: GalleryUnit[] }
>();

/** Cheap signature of a user's gallery-relevant media state. `total` (all
 *  generated rows, incl. tombstones) rises on insert; `live` (non-deleted) falls
 *  on delete — the pair changes on any insert/delete combination, and drops to
 *  0/0 when the rows are wiped (a test reset). A single aggregate count over the
 *  user's media — far cheaper than recomputing the unit list, though it scans the
 *  user's rows rather than being fully index-served. */
function galleryUserFingerprint(userId: string): string {
	const row = getDb()
		.select({
			total: sql<number>`count(*)`,
			live: sql<number>`coalesce(sum(case when ${media.hardDeletedAt} is null then 1 else 0 end), 0)`,
		})
		.from(media)
		.where(and(eq(media.userId, userId), eq(media.origin, 'generated')))
		.get();
	return `${row?.total ?? 0}:${row?.live ?? 0}`;
}

function galleryUnitsCacheKey(userId: string, opts: GalleryUnitOpts): string {
	// JSON-encode the tuple so an arbitrary model id can't forge a key collision.
	return JSON.stringify([
		userId,
		opts.kind ?? '',
		opts.model ?? '',
		opts.stack === false ? 'flat' : 'stack',
		opts.tzOffsetMinutes ?? 0,
	]);
}

/** `computeGalleryUnits` behind the per-(user, filter, tz) memo above. The
 *  returned array is shared read-only — callers slice/read it, never mutate. */
function computeGalleryUnitsCached(userId: string, opts: GalleryUnitOpts): GalleryUnit[] {
	const fingerprint = galleryUserFingerprint(userId);
	const key = galleryUnitsCacheKey(userId, opts);
	const hit = galleryUnitsCache.get(key);
	if (hit && hit.fingerprint === fingerprint && Date.now() < hit.expiresAt) return hit.units;
	const units = computeGalleryUnits(userId, opts);
	// Evict the oldest entry before inserting a new key, capping total size.
	if (!galleryUnitsCache.has(key) && galleryUnitsCache.size >= GALLERY_UNITS_CACHE_MAX) {
		const oldest = galleryUnitsCache.keys().next().value;
		if (oldest !== undefined) galleryUnitsCache.delete(oldest);
	}
	galleryUnitsCache.set(key, { fingerprint, expiresAt: Date.now() + GALLERY_UNITS_TTL_MS, units });
	return units;
}

/**
 * Per-day unit counts for the whole filtered library, newest-first, plus the
 * total. The client reserves exact scroll height from this before streaming any
 * unit data.
 */
export function computeGalleryLayout(userId: string, opts: GalleryUnitOpts = {}): GalleryLayout {
	const units = computeGalleryUnitsCached(userId, opts);
	// Units are newest-first with monotonically non-increasing dayKeys, so a Map
	// keyed by day accumulates in newest-first order with each day contiguous.
	const byDay = new Map<string, number>();
	for (const u of units) byDay.set(u.dayKey, (byDay.get(u.dayKey) ?? 0) + 1);
	return {
		days: [...byDay.entries()].map(([key, count]) => ({ key, units: count })),
		totalUnits: units.length,
	};
}

export interface GalleryUnitsPage {
	units: GalleryUnit[];
	/** Total units across the library, so the client can bound its window. */
	total: number;
}

/**
 * A contiguous slice of the newest-first unit stream, for the grid's demand
 * loader. Offset-paged (not cursor) because the client drives it by absolute
 * unit index derived from the layout counts, and — because conversation stacks
 * are global — the unit at any offset depends on every row newer than it, so the
 * stream can't be keyset-sliced at the DB anyway. The full list is computed via
 * `computeGalleryUnitsCached`, so all pages of one scroll (and the paired layout)
 * reuse a single O(library) pass instead of re-running it per page.
 */
export function listGalleryUnits(
	userId: string,
	opts: GalleryUnitOpts & { offset?: number; limit?: number } = {},
): GalleryUnitsPage {
	const all = computeGalleryUnitsCached(userId, opts);
	const offset = Math.max(0, Math.trunc(opts.offset ?? 0));
	const limit = Math.max(1, Math.min(Math.trunc(opts.limit ?? 120), 500));
	return { units: all.slice(offset, offset + limit), total: all.length };
}

/**
 * The complete member set of one gallery unit, newest-first — for drilling into
 * a stack. A conversation key (a bare conversation id) delegates to the
 * authoritative per-conversation read; a prompt-run key (`p:<leaderId>`)
 * recomputes the stacking and materializes that run's members. A solo/unknown
 * key returns `[]` (nothing to drill into).
 */
export function listGalleryUnitMembers(
	userId: string,
	unitKey: string,
	opts: { kind?: 'image' | 'video'; model?: string } = {},
): MediaListItem[] {
	if (!unitKey.startsWith('p:')) {
		// Conversation stack — the key IS the conversation id.
		return listMediaForConversation(unitKey, userId, opts);
	}
	// Prompt (orphan) run: re-run the shared grouping and pull the matching run's
	// members, then materialize them as full MediaListItems in run order.
	const run = groupGalleryItems(loadGalleryUnitSource(userId, opts)).find((g) => g.key === unitKey);
	if (!run) return [];
	const orderedIds = run.items.map((m) => m.id);
	const byId = new Map(getMediaListItemsByIds(userId, orderedIds).map((m) => [m.id, m]));
	return orderedIds.map((id) => byId.get(id)).filter((m): m is MediaListItem => m != null);
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
	opts: { kind?: 'image' | 'video'; kinds?: readonly MediaKind[]; model?: string } = {},
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
			originalPrompt: media.originalPrompt,
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
				opts.model ? eq(media.sourceModel, opts.model) : undefined,
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
	const result = db.transaction((tx) => {
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
	return result;
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
	const result = db.transaction((tx) => {
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
	return result;
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
