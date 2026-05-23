/**
 * Tests for the server-side markdown renderer (markdown-it + shiki). The
 * client-side renderer is covered by markdown-live.test; this exercises
 * the SERVER variant whose extras matter:
 *
 *   - Shiki syntax highlighting (with the language-alias map for js/ts/py/…)
 *   - Graceful fallback for unknown languages
 *   - Same link_open rewrite (target=_blank + rel=noopener noreferrer +
 *     gs-link class) as the live renderer, so the persisted HTML matches
 *     what the user saw streaming
 *   - The null-on-empty contract that lets callers leave content_html
 *     NULL in the DB for an empty message
 *
 * Shiki initializes a ~150KB grammar bundle on first call — slow but
 * cached for the lifetime of the process, so the second+ tests in this
 * file pay no per-test cost.
 */

import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '$lib/server/markdown/render';

describe('renderMarkdown — empty handling', () => {
	it('returns null for an empty string', async () => {
		expect(await renderMarkdown('')).toBeNull();
	});

	it('returns null for whitespace-only input', async () => {
		expect(await renderMarkdown('   \n\t\n  ')).toBeNull();
	});
});

describe('renderMarkdown — basic prose', () => {
	it('renders bold, italic, and headers', async () => {
		const out = (await renderMarkdown('# Heading\n\n**bold** *italic*'))!;
		expect(out).toContain('<h1>Heading</h1>');
		expect(out).toContain('<strong>bold</strong>');
		expect(out).toContain('<em>italic</em>');
	});

	it('escapes raw HTML (html: false guard)', async () => {
		const out = (await renderMarkdown('<script>alert(1)</script>'))!;
		expect(out).not.toContain('<script>');
		expect(out).toContain('&lt;script&gt;');
	});
});

describe('renderMarkdown — link rewrite', () => {
	it('adds target=_blank, rel=noopener noreferrer, and gs-link class', async () => {
		const out = (await renderMarkdown('[example](https://example.com)'))!;
		expect(out).toContain('href="https://example.com"');
		expect(out).toContain('target="_blank"');
		expect(out).toContain('rel="noopener noreferrer"');
		expect(out).toContain('class="gs-link"');
	});

	it('linkifies bare URLs with the same rewrite applied', async () => {
		const out = (await renderMarkdown('see https://example.com here'))!;
		expect(out).toContain('href="https://example.com"');
		expect(out).toContain('target="_blank"');
	});
});

describe('renderMarkdown — shiki syntax highlighting', () => {
	it('highlights a known language', async () => {
		const out = (await renderMarkdown('```typescript\nconst x: number = 1;\n```'))!;
		// Shiki emits a <pre class="shiki ..."> with inline styles per token.
		expect(out).toContain('class="shiki');
		expect(out).toContain('const');
	});

	it('resolves common aliases (js → javascript, ts → typescript, py → python)', async () => {
		const js = (await renderMarkdown('```js\nconst x = 1;\n```'))!;
		const ts = (await renderMarkdown('```ts\nconst x = 1;\n```'))!;
		const py = (await renderMarkdown('```py\nx = 1\n```'))!;
		expect(js).toContain('class="shiki');
		expect(ts).toContain('class="shiki');
		expect(py).toContain('class="shiki');
	});

	it('falls back to markdown-it default (plain <pre><code>) for unknown languages', async () => {
		const out = (await renderMarkdown('```fictional-lang\nsome code\n```'))!;
		// Default markdown-it codeblock — escaped, no shiki classes.
		expect(out).toContain('<pre>');
		expect(out).toContain('<code');
		expect(out).not.toContain('class="shiki');
		expect(out).toContain('some code');
	});

	it('falls back to plain <pre><code> for an unlabeled fence', async () => {
		const out = (await renderMarkdown('```\nplain\n```'))!;
		expect(out).toContain('<pre>');
		expect(out).not.toContain('class="shiki');
	});
});
