import { describe, expect, it } from 'vitest';
import { renderLiveMarkdown } from '$lib/markdown-live';

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

	it('renders fenced code blocks (no syntax highlighting at this layer)', () => {
		const out = renderLiveMarkdown('```\nconst x = 1;\n```');
		expect(out).toContain('<pre>');
		expect(out).toContain('const x = 1;');
		// Live renderer is intentionally shiki-free — no syntax classes.
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
		// markdown-it should escape these instead of passing through.
		expect(out).not.toContain('<script>');
		expect(out).toContain('&lt;script&gt;');
	});

	it('renders unordered lists', () => {
		const out = renderLiveMarkdown('- item one\n- item two');
		expect(out).toContain('<ul>');
		expect(out).toContain('<li>item one</li>');
	});
});
