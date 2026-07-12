import { beforeEach, describe, expect, it, vi } from 'vitest';

// select.ts reaches the embeddings + rerank clients in this graph; fully mock
// both so the dense and rerank legs are hermetic.
const embeddingsMock = vi.hoisted(() => vi.fn());
const rerankMock = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/endpoints/client', () => ({
	embeddings: embeddingsMock,
	rerank: rerankMock,
}));

import {
	selectRelevant,
	ELLIPSIS_MARKER,
	EMBED_CAP,
	type RelevanceConfig,
	type RerankConfig,
} from '$lib/server/retrieval/select';
import type { Chunk } from '$lib/server/retrieval/chunker';

function mk(blockIndex: number, body: string, breadcrumb = '', overlapPrefixLen = 0): Chunk {
	return {
		body,
		breadcrumb,
		blockIndex,
		overlapPrefixLen,
		text: breadcrumb ? `${breadcrumb}\n\n${body}` : body,
	};
}

const fakeEndpoint = { id: 'e', baseUrl: 'http://e', apiKey: null } as never;
function cfg(): RelevanceConfig {
	return {
		endpoint: fakeEndpoint,
		modelId: 'm',
		timeoutSeconds: 5,
		queryPrefix: '',
		documentPrefix: '',
		maxInputTokens: 512,
	};
}
function rerankCfg(overrides: Partial<RerankConfig> = {}): RerankConfig {
	return {
		endpoint: fakeEndpoint,
		modelId: 'rr',
		timeoutSeconds: 5,
		topN: 20,
		quirk: undefined,
		...overrides,
	};
}
const signal = new AbortController().signal;

beforeEach(() => {
	embeddingsMock.mockReset();
	rerankMock.mockReset();
});

describe('selectRelevant — BM25 only (no embedding config)', () => {
	it('selects relevant chunks and returns them in document order', async () => {
		const chunks = [
			mk(0, 'introduction to widgets and gadgets'),
			mk(1, 'pricing and billing for the quokka plan'),
			mk(2, 'shipping logistics and warehouse notes'),
		];
		const { content, mode } = await selectRelevant(chunks, 'quokka pricing', 1000, signal);
		expect(mode).toBe('relevance');
		expect(content).toContain('quokka plan');
	});

	it('inserts an ellipsis marker between non-adjacent selected chunks', async () => {
		// Two matching chunks with a gap (blockIndex 0 and 2) → ellipsis between.
		const chunks = [
			mk(0, 'quokka alpha'),
			mk(1, 'totally unrelated filler content about nothing in particular'),
			mk(2, 'quokka omega'),
		];
		// Budget fits only the two short quokka chunks, not the long filler.
		const { content } = await selectRelevant(chunks, 'quokka', 40, signal);
		expect(content).toContain('quokka alpha');
		expect(content).toContain('quokka omega');
		expect(content).toContain(ELLIPSIS_MARKER.trim());
	});

	it('slices the top chunk rather than returning empty when it alone exceeds budget', async () => {
		const chunks = [mk(0, 'quokka '.repeat(100)), mk(1, 'other')];
		const { content, mode } = await selectRelevant(chunks, 'quokka', 50, signal);
		expect(mode).toBe('relevance');
		expect(content.length).toBeLessThanOrEqual(50);
		expect(content).toContain('quokka');
	});

	it('dedupes the overlap prefix between adjacent selected chunks', async () => {
		const chunks = [
			mk(0, 'quokka first part ends here'),
			mk(1, 'ends here quokka second part', '', 'ends here '.length),
		];
		const { content } = await selectRelevant(chunks, 'quokka', 1000, signal);
		// "ends here" should appear once (overlap stripped), not duplicated.
		expect(content.match(/ends here/g)?.length).toBe(1);
	});
});

describe('selectRelevant — hybrid (embeddings + RRF)', () => {
	// Return a 2-D vector per input: [1,0] if it mentions quokka, else [0,1].
	function vectorFor(s: string): number[] {
		return /quokka/i.test(s) ? [1, 0] : [0, 1];
	}

	it('calls the embedding endpoint with [query, ...chunkTexts] and fuses results', async () => {
		embeddingsMock.mockImplementation(async (_ep: unknown, body: { input: string[] }) => ({
			data: body.input.map((s, index) => ({ index, embedding: vectorFor(s) })),
		}));

		const chunks = [
			mk(0, 'unrelated logistics and warehouse content'),
			mk(1, 'the quokka is a small marsupial'),
		];
		const { content, mode } = await selectRelevant(chunks, 'quokka', 1000, signal, cfg());

		expect(mode).toBe('relevance');
		expect(embeddingsMock).toHaveBeenCalledTimes(1);
		const passedInput = embeddingsMock.mock.calls[0][1].input;
		expect(passedInput[0]).toBe('quokka');
		expect(passedInput).toHaveLength(chunks.length + 1);
		expect(content).toContain('quokka');
	});

	it('falls back to BM25 (still mode:relevance) when the embedding call fails', async () => {
		embeddingsMock.mockRejectedValue(new Error('endpoint down'));
		const chunks = [mk(0, 'irrelevant filler'), mk(1, 'the quokka plan pricing')];
		const { content, mode } = await selectRelevant(chunks, 'quokka', 1000, signal, cfg());
		expect(mode).toBe('relevance');
		expect(content).toContain('quokka');
	});

	it('falls back to BM25 when the embedding response count is wrong', async () => {
		embeddingsMock.mockResolvedValue({ data: [{ index: 0, embedding: [1, 0] }] }); // too few
		const chunks = [mk(0, 'filler'), mk(1, 'quokka content here')];
		const { mode, content } = await selectRelevant(chunks, 'quokka', 1000, signal, cfg());
		expect(mode).toBe('relevance');
		expect(content).toContain('quokka');
	});

	it('splits embedding inputs into bounded batches (≤8 items each)', async () => {
		embeddingsMock.mockImplementation(async (_ep: unknown, body: { input: string[] }) => ({
			data: body.input.map((s, index) => ({ index, embedding: vectorFor(s) })),
		}));
		const chunks = Array.from({ length: 30 }, (_, i) =>
			mk(i, i === 20 ? 'the quokka section' : `filler block number ${i} here`),
		);
		await selectRelevant(chunks, 'quokka', 5000, signal, cfg());
		const calls = embeddingsMock.mock.calls;
		// 31 inputs (query + 30) → ceil(31/8) = 4 batches.
		expect(calls.length).toBe(4);
		for (const [, body] of calls) expect(body.input.length).toBeLessThanOrEqual(8);
		const total = calls.reduce((n: number, [, body]: any) => n + body.input.length, 0);
		expect(total).toBe(31);
		expect(calls[0][1].input[0]).toBe('quokka');
	});

	it('BM25-prefilters to EMBED_CAP candidates before embedding on large docs', async () => {
		embeddingsMock.mockImplementation(async (_ep: unknown, body: { input: string[] }) => ({
			data: body.input.map((s, index) => ({ index, embedding: vectorFor(s) })),
		}));
		// More chunks than the cap → only query + EMBED_CAP candidates embedded.
		// The lone quokka match ranks #1 in BM25, so it survives the prefilter.
		const chunks = Array.from({ length: EMBED_CAP + 6 }, (_, i) =>
			mk(i, i === 7 ? 'the quokka section' : `filler block number ${i} of text`),
		);
		await selectRelevant(chunks, 'quokka', 1000, signal, cfg());
		// Inputs split across batched requests — flatten to count the total embedded.
		const passedInput = embeddingsMock.mock.calls.flatMap((c) => c[1].input);
		expect(passedInput).toHaveLength(EMBED_CAP + 1); // EMBED_CAP candidates + query
		// The quokka chunk must survive the BM25 prefilter into the candidate set.
		expect(passedInput).toContain('the quokka section');
	});
});

describe('selectRelevant — rerank leg', () => {
	it('reorders selection by the reranker score, overriding the fused order', async () => {
		// BM25 ranks the "quokka" chunk first; the reranker promotes the other.
		// Budget fits exactly one chunk, so the reranked winner is what's returned.
		const chunks = [mk(0, 'quokka quokka quokka'), mk(1, 'marsupial habitat notes')];
		rerankMock.mockImplementation(async (_ep: unknown, body: { documents: string[] }) => {
			// Score the marsupial doc highest regardless of lexical match.
			return body.documents.map((d, index) => ({
				index,
				score: /marsupial/.test(d) ? 0.99 : 0.01,
			}));
		});
		const { content, mode } = await selectRelevant(
			chunks,
			'quokka',
			30,
			signal,
			undefined,
			rerankCfg(),
		);
		expect(mode).toBe('relevance');
		expect(rerankMock).toHaveBeenCalledTimes(1);
		expect(content).toContain('marsupial');
		expect(content).not.toContain('quokka quokka');
	});

	it('passes the fused candidate texts and model to the reranker', async () => {
		const chunks = [mk(0, 'quokka plan pricing'), mk(1, 'filler')];
		rerankMock.mockResolvedValue([{ index: 0, score: 1 }]);
		await selectRelevant(chunks, 'quokka', 1000, signal, undefined, rerankCfg());
		const [, body] = rerankMock.mock.calls[0] as unknown as [
			unknown,
			{ model: string; query: string; documents: string[] },
		];
		expect(body.model).toBe('rr');
		expect(body.query).toBe('quokka');
		expect(body.documents).toContain('quokka plan pricing');
	});

	it('keeps the fused order when the reranker fails (never errors)', async () => {
		rerankMock.mockImplementation(async () => {
			throw new Error('rerank endpoint down');
		});
		const chunks = [mk(0, 'the quokka plan'), mk(1, 'irrelevant filler')];
		const { content, mode } = await selectRelevant(
			chunks,
			'quokka',
			1000,
			signal,
			undefined,
			rerankCfg(),
		);
		expect(mode).toBe('relevance');
		expect(content).toContain('quokka');
	});

	it('keeps the fused order when the reranker returns no usable rows', async () => {
		rerankMock.mockResolvedValue([]);
		const chunks = [mk(0, 'the quokka plan'), mk(1, 'filler')];
		const { content } = await selectRelevant(
			chunks,
			'quokka',
			1000,
			signal,
			undefined,
			rerankCfg(),
		);
		expect(content).toContain('quokka');
	});

	it('does not call the reranker when only one candidate exists', async () => {
		rerankMock.mockResolvedValue([{ index: 0, score: 1 }]);
		await selectRelevant(
			[mk(0, 'lone quokka chunk')],
			'quokka',
			1000,
			signal,
			undefined,
			rerankCfg(),
		);
		expect(rerankMock).not.toHaveBeenCalled();
	});

	it('only reranks the top-N fused candidates', async () => {
		const chunks = Array.from({ length: 5 }, (_, i) => mk(i, `quokka block ${i} text`));
		rerankMock.mockImplementation(async (_ep: unknown, body: { documents: string[] }) =>
			body.documents.map((_d, index) => ({ index, score: 1 - index * 0.1 })),
		);
		await selectRelevant(chunks, 'quokka', 5000, signal, undefined, rerankCfg({ topN: 3 }));
		const [, body] = rerankMock.mock.calls[0] as unknown as [unknown, { documents: string[] }];
		expect(body.documents).toHaveLength(3);
	});
});

describe('selectRelevant — breadcrumbs (sections + outline)', () => {
	it('returns the selected sections and the full-document outline', async () => {
		const chunks = [
			mk(0, 'intro text about gadgets', 'Doc › Intro'),
			mk(1, 'the quokka plan pricing details', 'Doc › Pricing'),
			mk(2, 'shipping logistics notes', 'Doc › Shipping'),
		];
		// Budget fits only the matching (Pricing) chunk.
		const { sections, outline } = await selectRelevant(chunks, 'quokka pricing', 60, signal);
		expect(outline).toEqual(['Doc › Intro', 'Doc › Pricing', 'Doc › Shipping']);
		expect(sections).toEqual(['Doc › Pricing']);
	});

	it('collapses consecutive chunks of one section into a single outline entry', async () => {
		const chunks = [
			mk(0, 'part one of the section', 'Doc › A'),
			mk(1, 'part two of the section', 'Doc › A'),
			mk(2, 'a different section', 'Doc › B'),
		];
		const { outline } = await selectRelevant(chunks, 'section', 5000, signal);
		expect(outline).toEqual(['Doc › A', 'Doc › B']);
	});

	it('omits empty breadcrumbs (untitled, headingless content)', async () => {
		const chunks = [mk(0, 'just some text'), mk(1, 'more text here')];
		const { sections, outline } = await selectRelevant(chunks, 'text', 5000, signal);
		expect(outline).toEqual([]);
		expect(sections).toEqual([]);
	});
});

describe('the lexical leg must not impose document order on the fusion', () => {
	const signal = new AbortController().signal;

	/**
	 * `bm25Rank` returns EVERY chunk, scoring non-matching ones 0 and leaving them
	 * in document order. That total ordering is useful on its own (the BM25-only
	 * path relies on it), but it is NOT a lexical opinion — and feeding it to RRF
	 * hands the fusion a full-strength ranking that is really just "top of the page
	 * first", strong enough to outweigh a correct semantic hit.
	 */
	it('lets the dense leg win when the query has no lexical overlap with the page', async () => {
		// Six chunks, none sharing a token with the query. The answer is LAST in
		// document order — so document-order bias and semantics disagree, and we can
		// see which one actually decided.
		const chunks = [
			mk(0, 'aaaa aaaa aaaa'),
			mk(1, 'bbbb bbbb bbbb'),
			mk(2, 'cccc cccc cccc'),
			mk(3, 'dddd dddd dddd'),
			mk(4, 'eeee eeee eeee'),
			mk(5, 'THE ANSWER zzzz'),
		];
		// Query vector points at the last chunk; every other chunk is orthogonal.
		embeddingsMock.mockResolvedValue({
			data: [
				{ index: 0, embedding: [1, 0] }, // the query
				{ index: 1, embedding: [0, 1] },
				{ index: 2, embedding: [0, 1] },
				{ index: 3, embedding: [0, 1] },
				{ index: 4, embedding: [0, 1] },
				{ index: 5, embedding: [0, 1] },
				{ index: 6, embedding: [1, 0] }, // chunk 5 — the semantic match
			],
		});

		// Budget fits one chunk, so exactly one wins.
		const { mode, content } = await selectRelevant(chunks, 'qqqq wwww', 20, signal, cfg());

		expect(mode).toBe('relevance');
		expect(content).toContain('THE ANSWER');
	});

	it('still returns the page in document order when BM25 alone is in play', async () => {
		// No embedding config → the BM25-only path, where the zero-score total
		// ordering IS the intended fallback (you get the top of the page).
		const chunks = [mk(0, 'first section here'), mk(1, 'second section here')];
		const { content } = await selectRelevant(chunks, 'qqqq wwww', 25, signal);
		expect(content).toContain('first section');
	});
});
