import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ensureLiveMarkdown, renderLiveMarkdown } from '$lib/markdown-live';
import {
	resetLiveHighlighterForTests,
	setLiveHighlighterForTests,
} from '$lib/markdown-live-shiki.svelte';

// markdown-it is dynamic-imported in production. Force the load once so
// the rest of these synchronous tests get the real render path.
beforeAll(async () => {
	await ensureLiveMarkdown();
});

afterEach(() => {
	resetLiveHighlighterForTests();
});

describe('renderLiveMarkdown', () => {
	it('returns empty string for empty input', () => {
		expect(renderLiveMarkdown('')).toBe('');
	});

	it('renders bold + italic markdown to HTML', () => {
		const out = renderLiveMarkdown('hello **world** *italic*');
		expect(out).toContain('<strong>world</strong>');
		expect(out).toContain('<em>italic</em>');
	});

	it('renders headers', () => {
		expect(renderLiveMarkdown('# Title')).toContain('<h1>Title</h1>');
	});

	it('renders fenced code blocks as plain pre/code when the lazy highlighter has not loaded yet', () => {
		const out = renderLiveMarkdown('```python\nprint(1)\n```');
		expect(out).toContain('<pre>');
		expect(out).toContain('print(1)');
		// Pre-load: no syntax-class injection.
		expect(out).not.toContain('class="shiki');
	});

	it('renders inline code', () => {
		const out = renderLiveMarkdown('use `foo()` here');
		expect(out).toContain('<code>foo()</code>');
	});

	it('rewrites links with target=_blank + rel=noopener noreferrer', () => {
		const out = renderLiveMarkdown('[link](https://example.com)');
		expect(out).toContain('href="https://example.com"');
		expect(out).toContain('target="_blank"');
		expect(out).toContain('rel="noopener noreferrer"');
	});

	it('linkifies bare URLs', () => {
		const out = renderLiveMarkdown('see https://example.com for more');
		expect(out).toContain('href="https://example.com"');
	});

	it('does not pass raw HTML through (html: false guard)', () => {
		const out = renderLiveMarkdown('<script>alert(1)</script> text');
		expect(out).not.toContain('<script>');
		expect(out).toContain('&lt;script&gt;');
	});

	it('renders unordered lists', () => {
		const out = renderLiveMarkdown('- item one\n- item two');
		expect(out).toContain('<ul>');
		expect(out).toContain('<li>item one</li>');
	});
});

describe('renderLiveMarkdown — shiki upgrade path', () => {
	it('routes python/markdown fences through the highlighter once it lands', () => {
		const fake = {
			codeToHtml: (code: string, opts: { lang: string }) =>
				`<pre class="shiki" data-lang="${opts.lang}">${code}</pre>`,
		} as unknown as Parameters<typeof setLiveHighlighterForTests>[0];
		setLiveHighlighterForTests(fake);
		const out = renderLiveMarkdown('```python\nprint(1)\n```');
		expect(out).toContain('class="shiki"');
		expect(out).toContain('data-lang="python"');
	});

	it('honors language aliases via resolveLiveLang (py → python)', () => {
		const fake = {
			codeToHtml: (code: string, opts: { lang: string }) =>
				`<pre data-lang="${opts.lang}">${code}</pre>`,
		} as unknown as Parameters<typeof setLiveHighlighterForTests>[0];
		setLiveHighlighterForTests(fake);
		const out = renderLiveMarkdown('```py\nprint(1)\n```');
		expect(out).toContain('data-lang="python"');
	});

	it('falls back to plain pre for languages outside the client subset', () => {
		const fake = {
			codeToHtml: (code: string, opts: { lang: string }) =>
				`<pre data-lang="${opts.lang}">${code}</pre>`,
		} as unknown as Parameters<typeof setLiveHighlighterForTests>[0];
		setLiveHighlighterForTests(fake);
		const out = renderLiveMarkdown('```javascript\nconst x = 1;\n```');
		expect(out).not.toContain('data-lang=');
		expect(out).toContain('<pre>');
		expect(out).toContain('const x = 1;');
	});

	it('falls back to plain pre when the highlighter throws', () => {
		const fake = {
			codeToHtml: () => {
				throw new Error('grammar edge');
			},
		} as unknown as Parameters<typeof setLiveHighlighterForTests>[0];
		setLiveHighlighterForTests(fake);
		const out = renderLiveMarkdown('```python\nprint(1)\n```');
		expect(out).toContain('<pre>');
		expect(out).toContain('print(1)');
		expect(out).not.toContain('class="shiki');
	});
});
