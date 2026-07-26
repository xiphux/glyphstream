import { readFileSync } from 'node:fs';
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
import {
	MAX_BODY_LENGTH,
	MAX_NAME_LENGTH,
	MAX_TAGS,
	MAX_TAG_LENGTH,
} from '$lib/server/prompt-snippets/validate';
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

	// Regression: the metadata window used to be inferred from
	// `body.length === 0`, so a snippet with NO metadata never closed it at the
	// blank line — a `tags:`/`kinds:` line anywhere in the body was swallowed,
	// silently truncating the body and inventing metadata.
	describe('metadata window closes at the blank line', () => {
		// The body is preserved — that's the point. A warning IS expected here:
		// the line is ambiguous, so the parser keeps the content (the safe
		// direction) and tells the user rather than guessing silently.
		it('keeps a body whose first line looks like tags metadata', () => {
			const { snippets, warnings } = parseSnippetMarkdown(
				'## Booru\n\ntags: photorealistic, 8k\nmore body\n',
			);
			expect(snippets[0]).toMatchObject({
				name: 'Booru',
				body: 'tags: photorealistic, 8k\nmore body',
				tags: [],
			});
			expect(warnings).toHaveLength(1);
		});

		it('does not silently re-scope a generic snippet via a kinds-looking body line', () => {
			const { snippets } = parseSnippetMarkdown('## Booru\n\nkinds: image, video\nmore body\n');
			expect(snippets[0].kinds).toEqual([]);
			expect(snippets[0].body).toBe('kinds: image, video\nmore body');
		});

		it('does not drop a snippet whose whole body looks like metadata', () => {
			const { snippets, skipped } = parseSnippetMarkdown('## Booru\n\ntags: a, b\n');
			expect(skipped).toEqual([]);
			expect(snippets[0].body).toBe('tags: a, b');
		});

		// The behaviour must not depend on whether the snippet happens to have
		// metadata — that inconsistency was the tell for the original bug.
		it('parses the same body identically with and without metadata', () => {
			const withMeta = parseSnippetMarkdown('## A\nkinds: image\n\ntags: x, y\nrest\n').snippets[0];
			const without = parseSnippetMarkdown('## A\n\ntags: x, y\nrest\n').snippets[0];
			expect(without.body).toBe(withMeta.body);
			expect(without.tags).toEqual([]);
		});

		it('still reads metadata sitting directly under the heading', () => {
			const { snippets } = parseSnippetMarkdown('## A\nkinds: image\ntags: x\n\nbody\n');
			expect(snippets[0]).toMatchObject({ kinds: ['image'], tags: ['x'], body: 'body' });
		});
	});

	// The spec says metadata must follow the heading with no blank line. That
	// rule is deliberate (reading it as metadata would destroy a body whose
	// first line is a legitimate tag list), but failing SILENTLY was the
	// defect — a blank line after a heading is a natural thing to type.
	describe('warns when metadata follows a blank line', () => {
		it('warns and keeps the line as body', () => {
			const { snippets, warnings } = parseSnippetMarkdown(
				'## A\n\nkinds: image, video\n\nreal body\n',
			);
			expect(snippets[0].kinds).toEqual([]);
			expect(snippets[0].body).toBe('kinds: image, video\n\nreal body');
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toMatch(/metadata must follow the heading/);
		});

		it('does not warn when the author escaped the line explicitly', () => {
			const { snippets, warnings } = parseSnippetMarkdown('## A\n\n\\tags: 8k, photo\nrest\n');
			expect(warnings).toEqual([]);
			expect(snippets[0].body).toBe('tags: 8k, photo\nrest');
		});

		it('does not warn for an ordinary body', () => {
			expect(parseSnippetMarkdown('## A\n\nStyle: a clean look\n').warnings).toEqual([]);
		});

		it('does not warn when metadata was parsed correctly', () => {
			expect(parseSnippetMarkdown('## A\nkinds: image\n\nbody\n').warnings).toEqual([]);
		});

		// Regression: the check used to be armed only when NO metadata preceded
		// the blank line, so an identical body was diagnosed in one snippet and
		// silently swallowed in the next.
		it('warns even when the snippet already has metadata', () => {
			const { snippets, warnings } = parseSnippetMarkdown('## A\nkinds: image\n\ntags: x\nbody\n');
			expect(snippets[0]).toMatchObject({ kinds: ['image'], tags: [], body: 'tags: x\nbody' });
			expect(warnings).toHaveLength(1);
		});

		it('diagnoses the same body identically with and without prior metadata', () => {
			const withMeta = parseSnippetMarkdown('## A\nkinds: image\n\ntags: x\nbody\n');
			const without = parseSnippetMarkdown('## A\n\ntags: x\nbody\n');
			expect(withMeta.warnings).toHaveLength(without.warnings.length);
		});

		it('only inspects the first real body line, not later ones', () => {
			const { warnings } = parseSnippetMarkdown('## A\n\nprose first\n\ntags: later\n');
			expect(warnings).toEqual([]);
		});

		it('looks past several blank lines to the first real line', () => {
			const { warnings } = parseSnippetMarkdown('## A\n\n\n\nkinds: image\n');
			expect(warnings).toHaveLength(1);
		});
	});

	// A whitespace-only heading used to persist a row named " " — blank in the
	// list and the autocomplete, unreachable by search, and a state the
	// create/edit API rejects.
	describe('headings with no name', () => {
		it('skips a whitespace-only heading instead of naming a snippet " "', () => {
			const { snippets, skipped } = parseSnippetMarkdown('## \t \nbody here\n');
			expect(snippets).toEqual([]);
			expect(skipped[0]).toMatch(/no name/);
		});

		it('trims surrounding whitespace off a real name', () => {
			expect(parseSnippetMarkdown('##   Spaced   \n\nbody\n').snippets[0].name).toBe('Spaced');
		});
	});

	// Regression: the line model used to split on /\r?\n/ while HEADING and META
	// match with `.`, which excludes the FULL ECMAScript LineTerminator set. A
	// U+2028 (the soft break word processors and PDFs emit) therefore sat inside
	// a line, made it match neither pattern, and got absorbed into the previous
	// snippet's body — losing one snippet and corrupting its neighbour silently.
	describe('line terminators beyond LF/CR', () => {
		const LS = '\u2028';
		const PS = '\u2029';

		it('treats U+2028 as a line break so a heading is still a heading', () => {
			const { snippets } = parseSnippetMarkdown(`## Aaa\n\nbody a\n\n## Bbb${LS}X\n\nbody b\n`);
			expect(snippets.map((s) => s.name)).toEqual(['Aaa', 'Bbb']);
			// Crucially, Aaa's body is NOT polluted with Bbb's heading and body.
			expect(snippets[0].body).toBe('body a');
		});

		it('treats U+2029 the same way', () => {
			const { snippets } = parseSnippetMarkdown(`## Aaa\n\nbody a\n\n## Bbb${PS}X\n\nbody b\n`);
			expect(snippets.map((s) => s.name)).toEqual(['Aaa', 'Bbb']);
		});

		// The separator ends the metadata line, so `tags: a` is still read and the
		// remainder becomes ordinary body text. The point is that nothing is
		// silently LOST: previously the whole `tags:` line failed to match META
		// and every tag disappeared.
		it('does not let a separator in a tags line swallow the metadata', () => {
			const { snippets } = parseSnippetMarkdown(`## Aaa\ntags: a${LS}b, plain\n\nbody\n`);
			expect(snippets[0].tags).toEqual(['a']);
			expect(snippets[0].body).toContain('b, plain');
			expect(snippets[0].body).toContain('body');
		});

		// A lone CR has the identical property — split(/\r?\n/) never split on it
		// either, so a classic-Mac file was one giant line.
		it('treats a lone CR as a line break', () => {
			const { snippets } = parseSnippetMarkdown('## Aaa\r\rbody a\r');
			expect(snippets[0]).toMatchObject({ name: 'Aaa', body: 'body a' });
		});

		it('still treats CRLF as a single break, not two', () => {
			const { snippets } = parseSnippetMarkdown('## A\r\nkinds: image\r\n\r\nbody\r\nmore\r\n');
			expect(snippets[0]).toMatchObject({ kinds: ['image'], body: 'body\nmore' });
		});

		// Regression: the serializer split the body on '\n' while the parser
		// split on all four terminators, so a `## ` after a lone CR / U+2028 /
		// U+2029 went out UNESCAPED and re-parsed as a heading — truncating the
		// body and fabricating a snippet from its tail, with nothing reported.
		// Both halves of the round-trip must agree on what a line is.
		describe('serializer uses the same line model as the parser', () => {
			const trip = (body: string) => {
				const rendered = serializeSnippetMarkdown([
					{
						id: '1',
						name: 'Alpha',
						body,
						kinds: [],
						tags: [],
						usageCount: 0,
						createdAt: 0,
						updatedAt: 0,
					},
					{
						id: '2',
						name: 'Beta',
						body: 'second body',
						kinds: [],
						tags: [],
						usageCount: 0,
						createdAt: 0,
						updatedAt: 0,
					},
				]);
				return parseSnippetMarkdown(rendered);
			};

			for (const [label, ch] of [
				['LF', '\n'],
				['CRLF', '\r\n'],
				['CR', '\r'],
				['U+2028', LS],
				['U+2029', PS],
			] as const) {
				it(`does not let a ${label} in a body fabricate a snippet`, () => {
					const { snippets, skipped } = trip(`harmless${ch}## Injected${ch}evil payload`);
					expect(snippets.map((s) => s.name)).toEqual(['Alpha', 'Beta']);
					// Content preserved; only the spelling of the break normalizes to LF.
					expect(snippets[0].body).toBe('harmless\n## Injected\nevil payload');
					expect(skipped).toEqual([]);
				});
			}
		});
	});
});

// The docs teach this format by example, so a wrong example is a real defect —
// and it has happened: prettier formats ```markdown fences AS markdown, and its
// markdown formatter inserts a blank line after a heading, which silently
// rewrote the canonical example into the one shape the format rejects. The
// fences now carry <!-- prettier-ignore -->; this parses the doc's own example
// to make sure it stays correct if that guard is ever lost.
describe('the worked example in docs/prompt-snippets.md', () => {
	function firstMarkdownFence(doc: string): string {
		const m = /```markdown\n([\s\S]*?)```/.exec(doc);
		if (!m) throw new Error('no ```markdown fence found in the docs');
		return m[1];
	}

	it('parses the way the docs say it does', () => {
		const doc = readFileSync('docs/prompt-snippets.md', 'utf8');
		const { snippets, skipped, warnings } = parseSnippetMarkdown(firstMarkdownFence(doc));

		expect(skipped).toEqual([]);
		expect(warnings).toEqual([]);
		expect(snippets.map((s) => s.name)).toEqual(['Akira Toriyama Style', 'Terse Tone']);
		// The metadata must be READ as metadata — not swallowed into the body,
		// which is exactly what a stray blank line after the heading would do.
		expect(snippets[0].kinds).toEqual(['image', 'video']);
		expect(snippets[0].tags).toEqual(['anime', 'character']);
		expect(snippets[0].body).not.toContain('kinds:');
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

	// Regression: the serializer emitted bodies verbatim, so a body line that
	// re-parsed as structure split the snippet in two (or dropped it) on
	// re-import — silently, and destructively when Overwrite was ticked.
	describe('bodies that look like the format survive the round-trip', () => {
		const trip = (name: string, body: string) => {
			const rendered = serializeSnippetMarkdown([
				{ id: '1', name, body, kinds: [], tags: [], usageCount: 0, createdAt: 0, updatedAt: 0 },
			]);
			return parseSnippetMarkdown(rendered);
		};

		it('keeps a body containing a ## heading as one snippet', () => {
			const body = 'Write this:\n\n## Section\n\ndetails';
			const { snippets, skipped } = trip('Tmpl', body);
			expect(snippets).toHaveLength(1);
			expect(snippets[0]).toMatchObject({ name: 'Tmpl', body });
			expect(skipped).toEqual([]);
		});

		it('keeps a body that is entirely ## lines', () => {
			const body = '## Summary\n## Details';
			const { snippets, skipped } = trip('Format', body);
			expect(snippets).toHaveLength(1);
			expect(snippets[0].body).toBe(body);
			expect(skipped).toEqual([]);
		});

		it('keeps a body opening with a metadata-looking line', () => {
			const body = 'tags: photorealistic, 8k\nmore body';
			const { snippets } = trip('Booru', body);
			expect(snippets[0]).toMatchObject({ body, tags: [] });
		});

		// The escape must itself round-trip, or a body containing a literal
		// backslash-heading would lose a character on every export cycle.
		it('round-trips a body that already contains an escape sequence', () => {
			const body = '\\## Not a heading';
			expect(trip('Esc', body).snippets[0].body).toBe(body);
		});

		it('is stable across two consecutive round-trips', () => {
			const body = 'Intro\n\n## Section\n\ntags: x';
			const once = trip('Tmpl', body).snippets[0].body;
			expect(once).toBe(body);
			expect(trip('Tmpl', once).snippets[0].body).toBe(body);
		});

		it('leaves an ordinary body untouched in the rendered file', () => {
			const rendered = serializeSnippetMarkdown([
				{
					id: '1',
					name: 'Plain',
					body: 'just prose\nStyle: a clean look',
					kinds: [],
					tags: [],
					usageCount: 0,
					createdAt: 0,
					updatedAt: 0,
				},
			]);
			expect(rendered).not.toContain('\\');
		});
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

	// Regression: the "nothing parsed" early return fired BEFORE the parser's
	// per-entry reasons were surfaced, replacing a precise diagnosis with a
	// generic error. That's worst exactly when it matters most — a library
	// malformed the same way throughout, where the repeated reason IS the answer.
	describe('reports why when nothing could be imported', () => {
		it('returns the per-entry reasons instead of a generic error', () => {
			const u = seedUser();
			const result = importSnippets({ userId: u.id, content: '## A\n\n## B\n' });
			expect(result).toMatchObject({ ok: true, imported: 0, updated: 0 });
			expect(result.ok && result.skipped).toEqual(['A: no body', 'B: no body']);
		});

		// The realistic shape: converting a plain list by hand and leaving each
		// body on its heading line.
		it('diagnoses a library whose bodies are all on the heading line', () => {
			const u = seedUser();
			const result = importSnippets({
				userId: u.id,
				content: '## Akira Toriyama Style: clean linework\n\n## Terse Tone: no preamble\n',
			});
			expect(result).toMatchObject({ ok: true, imported: 0 });
			expect(result.ok && result.skipped).toHaveLength(2);
			expect(result.ok && result.skipped[0]).toMatch(/no body/);
			expect(listPromptSnippetsForUser(u.id)).toEqual([]);
		});

		it('still returns a guiding 400 when there is nothing to diagnose', () => {
			const u = seedUser();
			expect(importSnippets({ userId: u.id, content: 'just prose, no headings' })).toMatchObject({
				ok: false,
				status: 400,
			});
		});
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

	// Regression: import wrote rows directly, bypassing every cap the
	// create/edit API enforces. An oversize row could not afterwards be saved
	// from the settings form at all, since PATCH validates every field present
	// — so even renaming it tripped the body cap.
	describe('enforces the same size caps as the editor', () => {
		it('skips an over-long body instead of storing it', () => {
			const u = seedUser();
			const result = importSnippets({
				userId: u.id,
				content: `## Huge\n\n${'x'.repeat(MAX_BODY_LENGTH + 1)}\n`,
			});
			expect(result).toMatchObject({ ok: true, imported: 0 });
			expect(result.ok && result.skipped[0]).toMatch(/body over/);
			expect(listPromptSnippetsForUser(u.id)).toEqual([]);
		});

		it('skips an over-long name', () => {
			const u = seedUser();
			const result = importSnippets({
				userId: u.id,
				content: `## ${'n'.repeat(MAX_NAME_LENGTH + 1)}\n\nbody\n`,
			});
			expect(result).toMatchObject({ ok: true, imported: 0 });
			expect(result.ok && result.skipped[0]).toMatch(/name over/);
		});

		it('skips too many tags and an over-long tag', () => {
			const u = seedUser();
			const many = Array.from({ length: MAX_TAGS + 1 }, (_, i) => `t${i}`).join(', ');
			expect(
				importSnippets({ userId: u.id, content: `## A\ntags: ${many}\n\nbody\n` }).ok &&
					importSnippets({ userId: u.id, content: `## B\ntags: ${many}\n\nbody\n` }).ok,
			).toBe(true);
			expect(listPromptSnippetsForUser(u.id)).toEqual([]);

			const long = importSnippets({
				userId: u.id,
				content: `## C\ntags: ${'z'.repeat(MAX_TAG_LENGTH + 1)}\n\nbody\n`,
			});
			expect(long.ok && long.skipped[0]).toMatch(/tag over/);
		});

		// One oversize entry must not cost the user the other 99.
		it('imports the valid entries alongside a skipped oversize one', () => {
			const u = seedUser();
			const result = importSnippets({
				userId: u.id,
				content: `## Good\n\nfine body\n\n## Huge\n\n${'x'.repeat(MAX_BODY_LENGTH + 1)}\n`,
			});
			expect(result).toMatchObject({ ok: true, imported: 1 });
			expect(listPromptSnippetsForUser(u.id).map((s) => s.name)).toEqual(['Good']);
		});

		it('accepts an entry exactly at the caps', () => {
			const u = seedUser();
			const result = importSnippets({
				userId: u.id,
				content: `## ${'n'.repeat(MAX_NAME_LENGTH)}\n\n${'x'.repeat(MAX_BODY_LENGTH)}\n`,
			});
			expect(result).toMatchObject({ ok: true, imported: 1 });
		});
	});
});
