import { beforeEach, describe, expect, it, vi } from 'vitest';

// tool-search.ts reaches the embeddings client only through embed-rank.ts;
// mock it so the dense leg is hermetic (same approach as retrieval-select).
const embeddingsMock = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/endpoints/client', () => ({ embeddings: embeddingsMock }));

import { searchToolCatalog, clearToolDocVecCache } from '$lib/server/retrieval/tool-search';
import { EMBED_CAP, type RelevanceConfig } from '$lib/server/retrieval/embed-rank';
import type { DeferredToolEntry } from '$lib/server/tools/types';

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
const signal = new AbortController().signal;

const CATALOG: DeferredToolEntry[] = [
	{ name: 'mcp__gh__create_issue', description: 'Create an issue on GitHub', category: 'mcp:gh' },
	{ name: 'mcp__gh__view', description: 'View an issue', category: 'mcp:gh' },
	{ name: 'mcp__cal__create_event', description: 'Schedule a calendar event', category: 'mcp:cal' },
];

beforeEach(() => {
	embeddingsMock.mockReset();
	// The doc-vector cache is process-level module state; reset it so a warm entry
	// from a prior case doesn't change which inputs the next case embeds.
	clearToolDocVecCache();
});

describe('searchToolCatalog — BM25 only (no embeddings config)', () => {
	it('ranks the strongest lexical match first', async () => {
		// "issue" appears twice in create_issue (name + description), once in view,
		// and not at all in the calendar tool. (Avoid "create" — it's also a token
		// of mcp__cal__create_event's name.)
		const out = await searchToolCatalog('issue', CATALOG, undefined, signal);
		expect(out[0].name).toBe('mcp__gh__create_issue');
		expect(out.map((t) => t.name)).toContain('mcp__gh__view');
		expect(out.map((t) => t.name)).not.toContain('mcp__cal__create_event');
	});

	it('returns nothing when the query shares no terms with any tool', async () => {
		const out = await searchToolCatalog('xyzzy frobnicate', CATALOG, undefined, signal);
		expect(out).toEqual([]);
	});

	it('returns [] for an empty catalog without calling the embedder', async () => {
		expect(await searchToolCatalog('anything', [], cfg(), signal)).toEqual([]);
		expect(embeddingsMock).not.toHaveBeenCalled();
	});
});

describe('searchToolCatalog — hybrid (embeddings + RRF)', () => {
	// Deterministic 2-D vectors: anything calendar-ish aligns with the query
	// "book a meeting" even though they share NO lexical terms; issue-ish text is
	// orthogonal. Proves the semantic leg surfaces a tool BM25 alone would miss.
	function vectorFor(s: string): number[] {
		const t = s.toLowerCase();
		if (/(event|calendar|schedule|meeting|book)/.test(t)) return [1, 0];
		if (/issue/.test(t)) return [0, 1];
		return [0.5, 0.5];
	}

	it('surfaces a semantic match with zero lexical overlap', async () => {
		embeddingsMock.mockImplementation(async (_ep: unknown, body: { input: string[] }) => ({
			data: body.input.map((s, index) => ({ index, embedding: vectorFor(s) })),
		}));
		const out = await searchToolCatalog('book a meeting', CATALOG, cfg(), signal);
		expect(out[0].name).toBe('mcp__cal__create_event');
		// hybrid returns all embedded candidates (model picks); calendar tool wins.
		expect(out).toHaveLength(3);
	});

	it('falls back to BM25 when the embedding call fails', async () => {
		embeddingsMock.mockRejectedValue(new Error('endpoint down'));
		const out = await searchToolCatalog('issue', CATALOG, cfg(), signal);
		// BM25-only behavior: lexical matches only, calendar tool excluded.
		expect(out[0].name).toBe('mcp__gh__create_issue');
		expect(out.map((t) => t.name)).not.toContain('mcp__cal__create_event');
	});

	it('BM25-prefilters to EMBED_CAP candidates before embedding', async () => {
		embeddingsMock.mockImplementation(async (_ep: unknown, body: { input: string[] }) => ({
			data: body.input.map((s, index) => ({ index, embedding: vectorFor(s) })),
		}));
		// A catalog larger than the cap → only query + EMBED_CAP candidates embedded.
		// The lone "issue" tool ranks #1 in BM25, so it survives the prefilter.
		const bigCatalog: DeferredToolEntry[] = Array.from({ length: EMBED_CAP + 6 }, (_, i) =>
			i === 0
				? { name: 'mcp__gh__create_issue', description: 'Create an issue', category: 'mcp:gh' }
				: { name: `mcp__x__tool_${i}`, description: `filler tool ${i}`, category: 'mcp:x' },
		);
		await searchToolCatalog('issue', bigCatalog, cfg(), signal);
		// Inputs split across batched requests — flatten to count the total embedded.
		const passedInput = embeddingsMock.mock.calls.flatMap((c) => c[1].input);
		expect(passedInput).toHaveLength(EMBED_CAP + 1); // query + EMBED_CAP candidates
	});

	it('reuses cached doc vectors across calls — only the query is re-embedded', async () => {
		embeddingsMock.mockImplementation(async (_ep: unknown, body: { input: string[] }) => ({
			data: body.input.map((s, index) => ({ index, embedding: vectorFor(s) })),
		}));
		// First search embeds query + all 3 docs.
		await searchToolCatalog('book a meeting', CATALOG, cfg(), signal);
		const firstInputs = embeddingsMock.mock.calls.flatMap((c) => c[1].input);
		expect(firstInputs).toHaveLength(1 + 3);

		embeddingsMock.mockClear();
		// Second search over the same catalog: docs are cached, so only the new
		// query goes upstream.
		const out = await searchToolCatalog('schedule something', CATALOG, cfg(), signal);
		const secondInputs = embeddingsMock.mock.calls.flatMap((c) => c[1].input);
		expect(secondInputs).toHaveLength(1); // query only
		// Ranking still works off the cached vectors.
		expect(out[0].name).toBe('mcp__cal__create_event');
	});
});
