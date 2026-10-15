/**
 * The SQL behind gallery prompt search: the FTS5 keyword leg, the stored
 * prompt embeddings the semantic leg ranks, and the backfill queue that fills
 * them. The search itself (embedding the query, fusing the legs) is
 * `media/gallery-search.ts`.
 */
import { and, desc, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { getDb } from '../../client';
import { media } from '../../schema';
import type { MediaKind, MediaListItem } from '#lib/types/api.js';
import {
	assignedConversationId,
	attachConversationTitles,
	galleryKind,
	galleryVisibility,
} from './shape';

/** Max relevance-ranked results a single prompt search returns. No pagination —
 *  refine the query if the top N isn't enough (cf. `searchConversations`). */
export const MEDIA_SEARCH_CAP = 150;

/** Max stored prompt vectors the dense leg scans per query (bounds cosine/IO at
 *  household scale; the most-recent rows win past it). */
export const DENSE_CORPUS_CAP = 5000;

export type MediaSearchOpts = {
	kind?: 'image' | 'video';
	model?: string;
	/** Restrict to starred media, so the Favorites filter still applies while
	 *  searching (the gallery keeps its facets visible in search mode). */
	favorite?: boolean;
	limit?: number;
};

/** Keyword leg: bm25-ranked FTS5 hits as full `MediaListItem`s (titles attached). */
export function ftsRankMedia(
	userId: string,
	match: string,
	opts: MediaSearchOpts,
	limit: number,
): MediaListItem[] {
	const kindCond = opts.kind
		? sql`AND media.kind = ${opts.kind}`
		: sql`AND media.kind IN ('image', 'video')`;
	const modelCond = opts.model ? sql`AND media.source_model = ${opts.model}` : sql``;
	const favoriteCond = opts.favorite ? sql`AND media.favorited_at IS NOT NULL` : sql``;

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
		aspect_ratio: string | null;
		created_at: number;
		origin: 'generated' | 'uploaded';
		favorited_at: number | null;
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
			media.aspect_ratio AS aspect_ratio,
			media.created_at AS created_at,
			media.origin AS origin,
			media.favorited_at AS favorited_at,
			${assignedConversationId} AS conversation_id
		FROM media_prompt_fts f
		JOIN media ON media.id = f.media_id
		WHERE f.user_id = ${userId}
			AND media_prompt_fts MATCH ${match}
			AND media.deleted_at IS NULL
			AND media.origin = 'generated'
			${kindCond}
			${modelCond}
			${favoriteCond}
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
			aspectRatio: r.aspect_ratio,
			createdAt: r.created_at,
			origin: r.origin,
			favorite: r.favorited_at != null,
			conversationId: r.conversation_id,
			conversationTitle: null,
		})),
	);
}

export type DenseCorpusOpts = {
	kind?: 'image' | 'video';
	model?: string;
	favorite?: boolean;
	embeddingModel: string;
};

/**
 * A cheap, blob-free fingerprint of a user's dense-search corpus under these
 * filters: `count(*)` and a rowid sum (~1 ms). Any row entering or leaving the
 * corpus moves it, and a row's vector only changes by being cleared and
 * re-embedded, which moves it twice. `gallery-search.ts` reuses its decoded
 * vectors while this is unchanged.
 */
export function denseCorpusSignature(userId: string, opts: DenseCorpusOpts): string {
	const sig = getDb()
		.select({
			n: sql<number>`count(*)`,
			s: sql<number>`coalesce(sum(${media}.rowid), 0)`,
		})
		.from(media)
		.where(and(...mediaEmbeddingConditions(userId, opts)))
		.get();
	return `${sig?.n ?? 0}:${sig?.s ?? 0}`;
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
	// Excludes soft-deleted media (deleted_at set, prompt_full intact) so a
	// tombstoned-before-embedding row doesn't spend an embed call. Must stay in
	// lockstep with idx_media_unembedded's WHERE — matching the predicate is what
	// makes the partial index *usable*, but see the note on the index itself for
	// what makes it actually get *picked*: verify with EXPLAIN QUERY PLAN rather
	// than assuming, because a competing index nearly won this one.
	const embeddable = and(
		isNull(media.deletedAt),
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

/** The dense corpus filter, shared by the corpus read and its cache signature
 *  so the two can never describe different sets. */
function mediaEmbeddingConditions(
	userId: string,
	opts: DenseCorpusOpts,
): Array<Parameters<typeof and>[number]> {
	return [
		...galleryVisibility(userId),
		isNotNull(media.embedding),
		eq(media.embeddingModel, opts.embeddingModel),
		galleryKind(opts.kind),
		opts.model ? eq(media.sourceModel, opts.model) : undefined,
		opts.favorite ? isNotNull(media.favoritedAt) : undefined,
	].filter(Boolean);
}

/**
 * Candidate vectors for the semantic search leg: a user's embedded gallery media
 * for the active embedding model, newest-first, capped. Composes with
 * kind/model/favorite.
 */
export function listMediaEmbeddingsForUser(
	userId: string,
	opts: {
		kind?: 'image' | 'video';
		model?: string;
		/** Keep the dense leg inside the Favorites filter. Without it a semantic-only
		 *  neighbour that isn't starred would fuse into a favorites-filtered search,
		 *  since the keyword leg is the only other place the filter is applied. */
		favorite?: boolean;
		embeddingModel: string;
		limit?: number;
	},
): Array<{ id: string; embedding: Buffer }> {
	const limit = Math.max(1, Math.min(opts.limit ?? DENSE_CORPUS_CAP, 20000));
	const conditions = mediaEmbeddingConditions(userId, opts);

	return getDb()
		.select({ id: media.id, embedding: media.embedding })
		.from(media)
		.where(and(...conditions))
		.orderBy(desc(media.createdAt), desc(media.id))
		.limit(limit)
		.all() as Array<{ id: string; embedding: Buffer }>;
}
