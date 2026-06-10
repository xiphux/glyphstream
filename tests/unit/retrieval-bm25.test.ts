import { describe, expect, it } from 'vitest';
import { bm25Rank, tokenize } from '$lib/server/retrieval/bm25';

describe('tokenize', () => {
	it('lowercases and splits on non-alphanumeric runs', () => {
		expect(tokenize('Hello, World! foo_bar-baz')).toEqual(['hello', 'world', 'foo', 'bar', 'baz']);
	});

	it('drops single-character tokens', () => {
		expect(tokenize('a I/O x9 to')).toEqual(['x9', 'to']);
	});

	it('returns [] for empty / punctuation-only input', () => {
		expect(tokenize('')).toEqual([]);
		expect(tokenize('!!! ... ---')).toEqual([]);
	});

	it('preserves accented Latin terms (Unicode-aware, not ASCII-only)', () => {
		expect(tokenize('Café Müller naïve Größe')).toEqual(['café', 'müller', 'naïve', 'größe']);
	});

	it('keeps a run of CJK ideographs as a token', () => {
		// No inter-word spaces, so the run becomes one substring-matchable token.
		expect(tokenize('東京タワー and text')).toContain('text');
		expect(tokenize('東京タワー')).toEqual(['東京タワー']);
	});
});

describe('bm25Rank', () => {
	it('ranks the chunk containing a unique query term first', () => {
		const docs = [
			'the quarterly logistics report covers warehouse throughput',
			'the rare quokka of rottnest island is a small marsupial',
			'shipping containers move through the port at dawn',
		];
		const ranked = bm25Rank('quokka', docs);
		expect(ranked[0].index).toBe(1);
		expect(ranked[0].score).toBeGreaterThan(0);
	});

	it('keeps idf non-negative for a term present in every chunk', () => {
		// Classic BM25 idf would go negative when df === N; the BM25+ form we use
		// floors it at ~0 so a ubiquitous term never penalizes a chunk.
		const docs = ['the cat sat', 'the dog ran', 'the bird flew'];
		const ranked = bm25Rank('the', docs);
		for (const r of ranked) expect(r.score).toBeGreaterThanOrEqual(0);
		// Equal-length docs each containing "the" once → equal scores → doc order.
		expect(ranked.map((r) => r.index)).toEqual([0, 1, 2]);
	});

	it('ranks a chunk with a rare term far above one with only a ubiquitous term', () => {
		const docs = ['the common filler words here', 'the unicorn appears only once here'];
		const rare = bm25Rank('unicorn', docs);
		expect(rare[0].index).toBe(1);
		// The rare-term match scores well above any ubiquitous-term match.
		const ubiquitous = bm25Rank('the', docs);
		expect(rare[0].score).toBeGreaterThan(Math.max(...ubiquitous.map((r) => r.score)));
	});

	it('returns all docs in stable document order when the query matches nothing', () => {
		const docs = ['alpha beta', 'gamma delta', 'epsilon zeta'];
		const ranked = bm25Rank('nonexistentterm', docs);
		expect(ranked.map((r) => r.index)).toEqual([0, 1, 2]);
		expect(ranked.every((r) => r.score === 0)).toBe(true);
	});

	it('breaks score ties by ascending index', () => {
		const docs = ['match here', 'match here', 'match here'];
		const ranked = bm25Rank('match', docs);
		expect(ranked.map((r) => r.index)).toEqual([0, 1, 2]);
	});

	it('penalizes a longer chunk for the same term frequency (length normalization)', () => {
		const short = 'quokka';
		const long = `quokka ${'filler '.repeat(50)}`.trim();
		const ranked = bm25Rank('quokka', [short, long]);
		// Both contain "quokka" once; the shorter chunk scores higher.
		expect(ranked[0].index).toBe(0);
		const shortScore = ranked.find((r) => r.index === 0)!.score;
		const longScore = ranked.find((r) => r.index === 1)!.score;
		expect(shortScore).toBeGreaterThan(longScore);
	});
});
