import { beforeEach, describe, expect, it, vi } from 'vitest';

// select.ts is the only consumer of the embeddings client in this graph;
// fully mock it so the dense leg is hermetic.
const embeddingsMock = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/endpoints/client', () => ({ embeddings: embeddingsMock }));

import {
	selectRelevant,
	ELLIPSIS_MARKER,
	type RelevanceConfig,
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
function cfg(embedCap = 200): RelevanceConfig {
	return {
		endpoint: fakeEndpoint,
		modelId: 'm',
		timeoutSeconds: 5,
		embedCap,
		queryPrefix: '',
		documentPrefix: '',
		maxInputTokens: 512,
	};
}
const signal = new AbortController().signal;

beforeEach(() => {
	embeddingsMock.mockReset();
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

	it('BM25-prefilters to embedCap candidates before embedding on large docs', async () => {
		embeddingsMock.mockImplementation(async (_ep: unknown, body: { input: string[] }) => ({
			data: body.input.map((s, index) => ({ index, embedding: vectorFor(s) })),
		}));
		// 10 chunks, embedCap 3 → only query + 3 candidates embedded.
		const chunks = Array.from({ length: 10 }, (_, i) =>
			mk(i, i === 7 ? 'the quokka section' : `filler block number ${i} of text`),
		);
		await selectRelevant(chunks, 'quokka', 1000, signal, cfg(3));
		const passedInput = embeddingsMock.mock.calls[0][1].input;
		expect(passedInput).toHaveLength(3 + 1); // embedCap + query
		// The quokka chunk must survive the BM25 prefilter into the candidate set.
		expect(passedInput).toContain('the quokka section');
	});
});
