import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB }));
vi.mock('$lib/server/db/client', () => ({
	getDb: () => mocks.testDb,
	closeDb: () => {},
}));

import {
	parseSnippetMarkdown,
	serializeSnippetMarkdown,
} from '$lib/server/prompt-snippets/markdown';
import { importSnippets, MAX_IMPORT_SNIPPETS } from '$lib/server/prompt-snippets/import-snippets';
import { listPromptSnippetsForUser } from '$lib/server/db/queries/prompt-snippets';

beforeEach(() => {
	mocks.testDb = createTestDb();
});

afterEach(() => {
	closeTestDb();
});

const SAMPLE = `# My snippet library

Some preamble the parser should ignore.

## Akira Toriyama Style
kinds: image, video
tags: anime, character

clean and highly readable linework, appealing character-focused design
language, expressive forms.

## Terse Tone

No preamble. Answer directly.
`;

describe('parseSnippetMarkdown', () => {
	it('splits on headings and reads metadata', () => {
		const { snippets } = parseSnippetMarkdown(SAMPLE);
		expect(snippets).toHaveLength(2);
		expect(snippets[0]).toEqual({
			name: 'Akira Toriyama Style',
			body: 'clean and highly readable linework, appealing character-focused design\nlanguage, expressive forms.',
			kinds: ['image', 'video'],
			tags: ['anime', 'character'],
		});
	});

	it('treats a snippet with no metadata as generic and untagged', () => {
		const { snippets } = parseSnippetMarkdown(SAMPLE);
		expect(snippets[1]).toEqual({
			name: 'Terse Tone',
			body: 'No preamble. Answer directly.',
			kinds: [],
			tags: [],
		});
	});

	it('ignores any preamble before the first heading', () => {
		const { snippets } = parseSnippetMarkdown(SAMPLE);
		expect(snippets.map((s) => s.name)).toEqual(['Akira Toriyama Style', 'Terse Tone']);
	});

	// The trap this format has to avoid: style bodies genuinely open with
	// lines like "Style: ...", which a generic `key: value` metadata rule
	// would swallow, leaving the snippet bodyless.
	it('does not mistake a "Word:" body line for metadata', () => {
		const { snippets, skipped } = parseSnippetMarkdown(
			'## Portrait\nStyle: a clean, expressive look\nLighting: soft',
		);
		expect(skipped).toEqual([]);
		expect(snippets[0].body).toBe('Style: a clean, expressive look\nLighting: soft');
		expect(snippets[0].kinds).toEqual([]);
	});

	it('keeps blank lines and paragraphs inside a body', () => {
		const { snippets } = parseSnippetMarkdown('## A\nkinds: image\n\npara one\n\npara two\n');
		expect(snippets[0].body).toBe('para one\n\npara two');
	});

	it('accepts metadata in any case and with loose spacing', () => {
		const { snippets } = parseSnippetMarkdown('## A\nKINDS:  image ,video\nTags: x\n\nbody\n');
		expect(snippets[0].kinds).toEqual(['image', 'video']);
		expect(snippets[0].tags).toEqual(['x']);
	});

	it('warns on an unknown kind but keeps the valid ones', () => {
		const { snippets, warnings } = parseSnippetMarkdown('## A\nkinds: image, banana\n\nbody\n');
		expect(snippets[0].kinds).toEqual(['image']);
		expect(warnings[0]).toMatch(/banana/);
	});

	it('skips a heading with no body instead of failing the file', () => {
		const { snippets, skipped } = parseSnippetMarkdown('## Empty\n\n## Real\n\nbody\n');
		expect(snippets.map((s) => s.name)).toEqual(['Real']);
		expect(skipped[0]).toMatch(/Empty/);
	});

	it('de-dupes repeated kinds and tags', () => {
		const { snippets } = parseSnippetMarkdown('## A\nkinds: image, image\ntags: x, x\n\nbody\n');
		expect(snippets[0].kinds).toEqual(['image']);
		expect(snippets[0].tags).toEqual(['x']);
	});

	it('returns nothing for content with no headings', () => {
		expect(parseSnippetMarkdown('just some prose').snippets).toEqual([]);
	});

	it('handles CRLF line endings', () => {
		const { snippets } = parseSnippetMarkdown('## A\r\nkinds: image\r\n\r\nbody text\r\n');
		expect(snippets[0]).toMatchObject({ name: 'A', body: 'body text', kinds: ['image'] });
	});
});

describe('serializeSnippetMarkdown round-trip', () => {
	it('re-imports to exactly what was exported', () => {
		const original = parseSnippetMarkdown(SAMPLE).snippets;
		const rendered = serializeSnippetMarkdown(
			original.map((s, i) => ({
				...s,
				id: String(i),
				usageCount: 0,
				createdAt: 0,
				updatedAt: 0,
			})),
		);
		expect(parseSnippetMarkdown(rendered).snippets).toEqual(original);
	});

	it('omits empty metadata lines', () => {
		const out = serializeSnippetMarkdown([
			{
				id: '1',
				name: 'A',
				body: 'b',
				kinds: [],
				tags: [],
				usageCount: 0,
				createdAt: 0,
				updatedAt: 0,
			},
		]);
		expect(out).toBe('## A\n\nb\n');
	});
});

describe('importSnippets', () => {
	it('writes a parsed library to the DB', () => {
		const u = seedUser();
		const result = importSnippets({ userId: u.id, content: SAMPLE });
		expect(result).toMatchObject({ ok: true, imported: 2, updated: 0 });
		expect(listPromptSnippetsForUser(u.id).map((s) => s.name)).toEqual([
			'Akira Toriyama Style',
			'Terse Tone',
		]);
	});

	it('skips an existing name by default', () => {
		const u = seedUser();
		importSnippets({ userId: u.id, content: SAMPLE });
		const again = importSnippets({ userId: u.id, content: SAMPLE });
		expect(again).toMatchObject({ ok: true, imported: 0, updated: 0 });
		expect(again.ok && again.skipped).toHaveLength(2);
		expect(listPromptSnippetsForUser(u.id)).toHaveLength(2);
	});

	it('overwrites an existing name when asked', () => {
		const u = seedUser();
		importSnippets({ userId: u.id, content: SAMPLE });
		const result = importSnippets({
			userId: u.id,
			content: '## Terse Tone\n\nrewritten body\n',
			overwrite: true,
		});
		expect(result).toMatchObject({ ok: true, imported: 0, updated: 1 });
		const row = listPromptSnippetsForUser(u.id).find((s) => s.name === 'Terse Tone');
		expect(row?.body).toBe('rewritten body');
	});

	it('reports a duplicate heading within the file rather than throwing', () => {
		const u = seedUser();
		const result = importSnippets({ userId: u.id, content: '## A\n\none\n\n## A\n\ntwo\n' });
		expect(result).toMatchObject({ ok: true, imported: 1 });
		expect(result.ok && result.skipped[0]).toMatch(/duplicate heading/);
	});

	it('rejects empty content', () => {
		const u = seedUser();
		expect(importSnippets({ userId: u.id, content: '   ' })).toMatchObject({
			ok: false,
			status: 400,
		});
	});

	it('rejects content with no parseable snippets', () => {
		const u = seedUser();
		const result = importSnippets({ userId: u.id, content: 'no headings here' });
		expect(result).toMatchObject({ ok: false, status: 400 });
		expect(result.ok === false && result.error).toMatch(/## Name/);
	});

	it('refuses a runaway paste past the cap', () => {
		const u = seedUser();
		const huge = Array.from(
			{ length: MAX_IMPORT_SNIPPETS + 1 },
			(_, i) => `## S${i}\n\nbody ${i}\n`,
		).join('\n');
		expect(importSnippets({ userId: u.id, content: huge })).toMatchObject({
			ok: false,
			status: 400,
		});
		expect(listPromptSnippetsForUser(u.id)).toEqual([]);
	});

	it('imports a realistic ~100-entry library', () => {
		const u = seedUser();
		const lib = Array.from(
			{ length: 100 },
			(_, i) => `## Style ${i}\nkinds: image\n\nA long descriptive style body for ${i}.\n`,
		).join('\n');
		const result = importSnippets({ userId: u.id, content: lib });
		expect(result).toMatchObject({ ok: true, imported: 100 });
		expect(listPromptSnippetsForUser(u.id)).toHaveLength(100);
	});

	it('scopes the import to the caller', () => {
		const a = seedUser();
		const b = seedUser();
		importSnippets({ userId: a.id, content: SAMPLE });
		expect(listPromptSnippetsForUser(b.id)).toEqual([]);
	});
});
