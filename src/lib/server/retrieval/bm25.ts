/**
 * Okapi BM25 lexical scorer, scoped to a single document's chunk set.
 *
 * There is no global/cross-request index — IDF is computed over just the
 * chunks of the page being read right now. That keeps the feature stateless
 * and lightweight (no persistence, no warm-up): one fetch, score, discard.
 *
 * This is the always-on leg of `fetch_url`'s relevance selection. It catches
 * exact and rare terms (API names, error codes, version numbers, proper
 * nouns) that dense embeddings blur together; the dense leg (when an
 * embedding model is configured) adds semantic/paraphrase recall on top via
 * rank fusion in `select.ts`.
 */

export interface Bm25Options {
	/** Term-frequency saturation. Higher = TF matters more before plateauing. */
	k1?: number;
	/** Length normalization strength in [0,1]. 0 = ignore length, 1 = full. */
	b?: number;
}

export interface ScoredChunk {
	index: number;
	score: number;
}

const DEFAULT_K1 = 1.5;
const DEFAULT_B = 0.75;

/**
 * Lowercase, split on non-alphanumeric runs, drop single-char tokens.
 *
 * Deliberately ASCII-only: `[^a-z0-9]+` discards CJK and accented terms.
 * That's acceptable for the lexical leg — the dense embedding leg covers
 * multilingual and semantic recall. No stemming, no stopword list; ubiquitous
 * words get a near-zero IDF naturally, so they cost nothing to keep.
 */
export function tokenize(s: string): string[] {
	return s
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((t) => t.length >= 2);
}

/**
 * Score every doc in `docs` against `query` and return them sorted by score
 * descending, ties broken by ascending index (stable + document-order bias).
 * Always returns one entry per doc, so callers can rely on a total ordering.
 *
 * IDF uses the non-negative ("BM25+") form
 *   idf = ln(1 + (N - df + 0.5) / (df + 0.5))
 * so a term appearing in every chunk contributes ~0 rather than going
 * negative (which would perversely penalize chunks for containing it).
 */
export function bm25Rank(query: string, docs: string[], opts: Bm25Options = {}): ScoredChunk[] {
	const k1 = opts.k1 ?? DEFAULT_K1;
	const b = opts.b ?? DEFAULT_B;
	const N = docs.length;

	const queryTerms = [...new Set(tokenize(query))];

	// Per-doc term-frequency maps + lengths, and document frequency per term.
	const docTokens = docs.map(tokenize);
	const docLengths = docTokens.map((t) => t.length);
	const avgdl = N > 0 ? docLengths.reduce((a, c) => a + c, 0) / N : 0;

	const tfPerDoc: Array<Map<string, number>> = docTokens.map((tokens) => {
		const m = new Map<string, number>();
		for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
		return m;
	});

	// Document frequency, computed only for query terms (all that matter).
	const df = new Map<string, number>();
	for (const term of queryTerms) {
		let count = 0;
		for (const tf of tfPerDoc) if (tf.has(term)) count++;
		df.set(term, count);
	}

	const idf = new Map<string, number>();
	for (const term of queryTerms) {
		const dft = df.get(term) ?? 0;
		idf.set(term, Math.log(1 + (N - dft + 0.5) / (dft + 0.5)));
	}

	const scored: ScoredChunk[] = docs.map((_, index) => {
		const tf = tfPerDoc[index];
		const len = docLengths[index];
		let score = 0;
		for (const term of queryTerms) {
			const f = tf.get(term);
			if (!f) continue;
			const denom = f + k1 * (1 - b + (avgdl > 0 ? (b * len) / avgdl : 0));
			score += (idf.get(term) ?? 0) * ((f * (k1 + 1)) / denom);
		}
		return { index, score };
	});

	scored.sort((x, y) => (y.score === x.score ? x.index - y.index : y.score - x.score));
	return scored;
}
