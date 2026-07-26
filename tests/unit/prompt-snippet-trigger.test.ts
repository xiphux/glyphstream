import { describe, expect, it } from 'vitest';
import { filterSnippets, snippetMenuQuery, SNIPPET_TRIGGER } from '$lib/prompt-snippet-trigger';
import type { PromptSnippet, SnippetKind } from '$lib/types/api';

/** Query at the end of `text` — the common "user is typing" case. */
function atEnd(text: string) {
	return snippetMenuQuery(text, text.length);
}

describe('snippetMenuQuery — when the menu opens', () => {
	it('opens on a trigger at the very start of the draft', () => {
		expect(atEnd(';tori')).toEqual({ query: 'tori', start: 0 });
	});

	it('opens on a trigger after a space, mid-message', () => {
		expect(atEnd('Style: ;tori')).toEqual({ query: 'tori', start: 7 });
	});

	it('opens on a trigger after a newline', () => {
		expect(atEnd('Description: a cat\n;tori')).toEqual({ query: 'tori', start: 19 });
	});

	it('treats a bare trigger as "show all"', () => {
		expect(atEnd('Style: ;')).toEqual({ query: '', start: 7 });
	});

	it('reports the trigger index so the caller can replace the whole token', () => {
		const text = 'A cat in the ;anime';
		const q = snippetMenuQuery(text, text.length);
		expect(text.slice(q!.start, text.length)).toBe(';anime');
	});
});

// The whole reason `;` is safe to adopt: its two overwhelmingly common uses in
// real text put it after a word character or before a space.
describe('snippetMenuQuery — when it must stay closed', () => {
	it('does not open mid-word (a trailing semicolon in code)', () => {
		expect(atEnd('const x = 1;')).toBeNull();
	});

	it('does not open for a semicolon that ends a clause', () => {
		expect(snippetMenuQuery('foo; bar', 4)).toBeNull();
	});

	it('does not open when the trigger follows a non-space character', () => {
		expect(atEnd('a;b')).toBeNull();
	});

	it('does not open after a slash, keeping it disjoint from the skill menu', () => {
		expect(atEnd('/;x')).toBeNull();
	});

	it('closes once whitespace is typed after the query', () => {
		expect(atEnd(';tori ')).toBeNull();
		expect(atEnd(';tori a cat')).toBeNull();
	});

	it('returns null for text with no trigger at all', () => {
		expect(atEnd('a cat sitting on a mat')).toBeNull();
		expect(atEnd('')).toBeNull();
	});

	it('returns null for an out-of-range caret', () => {
		expect(snippetMenuQuery(';tori', -1)).toBeNull();
		expect(snippetMenuQuery(';tori', 99)).toBeNull();
	});
});

// The caret is the whole point of this module: the menu must reflect where the
// user actually is, not the end of the draft.
describe('snippetMenuQuery — caret placement', () => {
	it('reads the token the caret sits in, not the last one in the draft', () => {
		const text = ';anime and ;mecha';
		expect(snippetMenuQuery(text, 6)).toEqual({ query: 'anime', start: 0 });
		expect(snippetMenuQuery(text, text.length)).toEqual({ query: 'mecha', start: 11 });
	});

	it('reads a partial query when the caret is inside the token', () => {
		expect(snippetMenuQuery(';anime', 3)).toEqual({ query: 'an', start: 0 });
	});

	it('stays closed when the caret has moved to unrelated text', () => {
		expect(snippetMenuQuery('a cat ;anime', 3)).toBeNull();
	});

	it('exposes the trigger char it matches on', () => {
		expect(SNIPPET_TRIGGER).toBe(';');
	});
});

function snip(over: Partial<PromptSnippet> & { name: string }): PromptSnippet {
	return {
		id: over.name,
		body: `body of ${over.name}`,
		kinds: [],
		tags: [],
		usageCount: 0,
		createdAt: 0,
		updatedAt: 0,
		...over,
	};
}

const LIB: PromptSnippet[] = [
	snip({ name: 'Akira Toriyama Style', kinds: ['image'], tags: ['anime'] }),
	snip({ name: 'Anime Style', kinds: ['image'] }),
	snip({ name: 'Cinematic Shot', kinds: ['video'] }),
	snip({ name: 'Terse Tone' }), // generic
];

const names = (out: PromptSnippet[]) => out.map((s) => s.name);

describe('filterSnippets — matching', () => {
	it('returns everything for an empty query', () => {
		expect(filterSnippets(LIB, '', null)).toHaveLength(4);
	});

	it('matches a substring mid-name, not just a prefix', () => {
		expect(names(filterSnippets(LIB, 'tori', null))).toEqual(['Akira Toriyama Style']);
	});

	it('is case-insensitive', () => {
		expect(names(filterSnippets(LIB, 'TORIYAMA', 'image'))).toEqual(['Akira Toriyama Style']);
	});

	it('matches on tags too', () => {
		expect(names(filterSnippets(LIB, 'anime', 'image'))).toContain('Akira Toriyama Style');
	});

	it('returns nothing when the query matches nothing', () => {
		expect(filterSnippets(LIB, 'zzzz', null)).toEqual([]);
	});
});

describe('filterSnippets — modality filtering', () => {
	it('hides other modalities’ snippets but keeps generic ones', () => {
		expect(names(filterSnippets(LIB, '', 'chat'))).toEqual(['Terse Tone']);
	});

	it('shows the active modality plus generic', () => {
		expect(names(filterSnippets(LIB, '', 'video')).sort()).toEqual([
			'Cinematic Shot',
			'Terse Tone',
		]);
	});

	it('does not filter when no model kind is resolved', () => {
		expect(filterSnippets(LIB, '', null)).toHaveLength(4);
	});

	// The escape hatch: suppress clutter, never everything. A snippet that
	// exists and matches the query must never be unreachable.
	it('falls back to the unfiltered list when the kind filter would empty it', () => {
		expect(names(filterSnippets(LIB, 'tori', 'chat'))).toEqual(['Akira Toriyama Style']);
	});

	it('does not fall back when the kind filter leaves something', () => {
		expect(names(filterSnippets(LIB, 'style', 'image'))).toEqual([
			'Akira Toriyama Style',
			'Anime Style',
		]);
	});
});

describe('filterSnippets — ordering', () => {
	it('puts most-used first, then alphabetical', () => {
		const lib = [
			snip({ name: 'Bravo', usageCount: 1 }),
			snip({ name: 'Alpha', usageCount: 1 }),
			snip({ name: 'Charlie', usageCount: 9 }),
		];
		expect(names(filterSnippets(lib, '', null))).toEqual(['Charlie', 'Alpha', 'Bravo']);
	});

	it('does not mutate the caller’s array (it is the shared cache)', () => {
		const lib = [snip({ name: 'Bravo', usageCount: 1 }), snip({ name: 'Alpha', usageCount: 9 })];
		filterSnippets(lib, '', null);
		expect(names(lib)).toEqual(['Bravo', 'Alpha']);
	});
});

describe('filterSnippets — kind values are the snippet subset', () => {
	it('accepts every SnippetKind', () => {
		const kinds: SnippetKind[] = ['chat', 'image', 'video'];
		for (const k of kinds) expect(() => filterSnippets(LIB, '', k)).not.toThrow();
	});
});
