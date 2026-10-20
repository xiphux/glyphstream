/**
 * Gallery prompt search: the keyword leg from the FTS5 index, fused with a
 * semantic leg over stored prompt embeddings when an `[embeddings]` endpoint
 * is configured.
 *
 * A service rather than a query: it calls the embedding endpoint and keeps
 * decoded vectors in memory. The SQL it runs lives in `db/queries/media/search.ts`.
 */
import type { MediaListItem } from '#lib/types/api.js';
import {
	DENSE_CORPUS_CAP,
	denseCorpusSignature,
	ftsRankMedia,
	getMediaListItemsByIds,
	listMediaEmbeddingsForUser,
	MEDIA_SEARCH_CAP,
	type DenseCorpusOpts,
	type MediaSearchOpts,
} from '../db/queries/media';
import { buildFtsQuery } from '../db/queries/search';
import { DEFAULT_GALLERY_SEARCH_MIN_SIMILARITY } from '../endpoints/config';
import { resolveRelevanceConfig } from '../retrieval/embeddings-config';
import { embedQuery } from '../retrieval/embed-rank';
import { cosineRank, decodeVector } from '../retrieval/vector';
import { fuseRankings } from '../retrieval/fusion';
import { createLogger } from '../log';

const log = createLogger('gallery-search');

/** Semantic neighbours the dense leg contributes to the fusion. Bounded so a
 *  query returns keyword hits + a modest set of synonym matches, not the whole
 *  ranked corpus. */
const DENSE_TOPK = 100;

/**
 * The decoded dense-search corpus, cached per (user, filters, embedding model).
 *
 * Search runs per keystroke, and each run re-read and decoded up to
 * DENSE_CORPUS_CAP blobs (~11 ms at 5,000 x 768 dims) to get the same vectors
 * as last time. An entry is reused while a blob-free signature over the same
 * filter (`count(*)` and a rowid sum, ~1 ms) is unchanged: any row entering or
 * leaving the corpus (a backfill write, a delete, a star under Favorites)
 * moves it, and a row's vector only changes by being cleared and re-embedded,
 * which moves it twice. Few entries, because each holds the decoded vectors
 * (~15 MB at that size).
 */
const DENSE_CORPUS_CACHE_MAX = 4;
const denseCorpusCache = new Map<
	string,
	{ signature: string; ids: string[]; vectors: Float32Array[] }
>();

function denseCorpusFor(
	userId: string,
	opts: DenseCorpusOpts,
): { ids: string[]; vectors: Float32Array[] } {
	const key = JSON.stringify([userId, opts.kind, opts.model, opts.favorite, opts.embeddingModel]);
	const signature = denseCorpusSignature(userId, opts);
	const hit = denseCorpusCache.get(key);
	if (hit && hit.signature === signature) {
		denseCorpusCache.delete(key);
		denseCorpusCache.set(key, hit);
		return hit;
	}
	const rows = listMediaEmbeddingsForUser(userId, { ...opts, limit: DENSE_CORPUS_CAP });
	const entry = {
		signature,
		ids: rows.map((r) => r.id),
		vectors: rows.map((r) => decodeVector(r.embedding)),
	};
	denseCorpusCache.delete(key);
	denseCorpusCache.set(key, entry);
	while (denseCorpusCache.size > DENSE_CORPUS_CACHE_MAX) {
		denseCorpusCache.delete(denseCorpusCache.keys().next().value as string);
	}
	return entry;
}

/**
 * Relevance-ranked prompt search over a user's gallery media. Keyword leg: the
 * `media_prompt_fts` FTS5 index (migration 20260622120000), ranked by bm25.
 * When an `[embeddings]` endpoint is configured, a semantic leg (cosine over
 * stored `prompt_full` vectors) fuses in via RRF, surfacing synonym matches the
 * keyword leg misses; it degrades to keyword-only on any failure (no config,
 * endpoint down) — same as memory recall. Returns up to {@link MEDIA_SEARCH_CAP}
 * `MediaListItem`s best-match-first (or newest-first under `sort: 'newest'`),
 * no cursor (a ranked mode, not the browse).
 *
 * Visibility (deleted_at / origin) + kind/model/favorite compose on both legs —
 * the dense leg included, or a semantic-only neighbour outside the filter would
 * fuse in past it. A dense
 * neighbour must clear the configurable cosine floor
 * (`gallery_search_min_similarity`, default 0.5) to surface, so noise doesn't pad
 * the results — which means an embeddings-on query with no keyword hit and no
 * above-floor neighbour can also return empty, same as keyword-only mode.
 */
export async function searchMediaForUser(
	userId: string,
	rawQuery: string,
	opts: MediaSearchOpts = {},
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

		const corpus = denseCorpusFor(userId, {
			kind: opts.kind,
			model: opts.model,
			favorite: opts.favorite,
			embeddingModel: cfg.modelId,
		});
		if (corpus.ids.length === 0) return ftsItems.slice(0, limit);

		// Apply a cosine floor BEFORE taking the top-K: cosineRank ranks the whole
		// loaded candidate set (up to DENSE_CORPUS_CAP), so without a floor the
		// dense leg pads results with arbitrary nearest-neighbours (unrelated
		// prompts) — only genuine synonyms should surface. Threshold is
		// config-tunable (model-dependent cosine scales).
		const minSim = cfg.gallerySearchMinSimilarity ?? DEFAULT_GALLERY_SEARCH_MIN_SIMILARITY;
		const denseRanked = cosineRank(qvec, corpus.vectors)
			.filter((sc) => sc.score >= minSim)
			.slice(0, DENSE_TOPK);
		const denseIds = denseRanked.map((sc) => corpus.ids[sc.index]);

		// Fuse the two rankings over a shared id→index space (RRF ignores scores,
		// uses rank position). The union includes semantic-only ids, so synonym
		// matches surface; keyword hits get an extra contribution and rank higher.
		const ftsIds = ftsItems.map((i) => i.id);
		const idList = [...new Set([...ftsIds, ...denseIds])];

		// Newest: the result set is the same union; only the order differs, so
		// there's nothing for RRF to do. The keyword leg is already date-ordered
		// under its cap, so the newest keyword hits are all in the union.
		if (opts.sort === 'newest') {
			const items = materialize(userId, ftsItems, idList);
			items.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
			return items.slice(0, limit);
		}

		const idxOf = new Map(idList.map((id, i) => [id, i]));
		const ftsRanking = ftsIds.map((id) => ({ index: idxOf.get(id)!, score: 0 }));
		const denseRanking = denseIds.map((id) => ({ index: idxOf.get(id)!, score: 0 }));
		const orderedIds = fuseRankings([ftsRanking, denseRanking])
			.slice(0, limit)
			.map((sc) => idList[sc.index]);

		return materialize(userId, ftsItems, orderedIds);
	} catch (e) {
		log.warn('dense leg failed; keyword-only:', e);
		return ftsItems.slice(0, limit);
	}
}

/** `ids` as full rows, in order: reuse the keyword rows we already have and
 *  fetch only the semantic-only ids. */
function materialize(userId: string, ftsItems: MediaListItem[], ids: string[]): MediaListItem[] {
	const byId = new Map(ftsItems.map((i) => [i.id, i]));
	const missing = ids.filter((id) => !byId.has(id));
	for (const it of getMediaListItemsByIds(userId, missing)) byId.set(it.id, it);
	return ids.map((id) => byId.get(id)).filter((x): x is MediaListItem => !!x);
}
