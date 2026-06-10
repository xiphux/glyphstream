import { describe, expect, it } from 'vitest';
import { chunkArticleHtml, chunkPlainText } from '$lib/server/retrieval/chunker';

describe('chunkArticleHtml', () => {
	it('builds a Title › H2 › H3 breadcrumb from the heading hierarchy', () => {
		const html = `
			<h2>Pricing</h2>
			<p>Intro paragraph under pricing.</p>
			<h3>Enterprise</h3>
			<p>Enterprise tier details and pricing notes.</p>
		`;
		const chunks = chunkArticleHtml(html, 'Acme Docs');
		const enterprise = chunks.find((c) => c.body.includes('Enterprise tier'));
		expect(enterprise?.breadcrumb).toBe('Acme Docs › Pricing › Enterprise');
		const intro = chunks.find((c) => c.body.includes('Intro paragraph'));
		expect(intro?.breadcrumb).toBe('Acme Docs › Pricing');
	});

	it('prepends the breadcrumb to the chunk text', () => {
		const chunks = chunkArticleHtml(
			'<h2>Sec</h2><p>Body text here that is reasonably long.</p>',
			'T',
		);
		expect(chunks[0].text.startsWith('T › Sec\n\n')).toBe(true);
	});

	it('packs adjacent same-section paragraphs into one chunk', () => {
		const html = '<h2>S</h2><p>aaaa</p><p>bbbb</p><p>cccc</p>';
		const chunks = chunkArticleHtml(html, '', { targetChars: 1000 });
		expect(chunks).toHaveLength(1);
		expect(chunks[0].body).toBe('aaaa\n\nbbbb\n\ncccc');
	});

	it('flushes a new chunk when the breadcrumb changes', () => {
		const html = '<h2>One</h2><p>first</p><h2>Two</h2><p>second</p>';
		const chunks = chunkArticleHtml(html, '', { targetChars: 1000 });
		expect(chunks).toHaveLength(2);
		expect(chunks[0].breadcrumb).toBe('One');
		expect(chunks[1].breadcrumb).toBe('Two');
		expect(chunks[1].blockIndex).toBe(1);
	});

	it('splits an oversized single block and overlaps the pieces', () => {
		const big = 'word '.repeat(400).trim(); // 1999 chars, one <p>
		const chunks = chunkArticleHtml(`<p>${big}</p>`, '', { targetChars: 500, maxChars: 600 });
		expect(chunks.length).toBeGreaterThan(1);
		// At least one continuation chunk carries an overlap prefix from its predecessor.
		expect(chunks.slice(1).some((c) => c.overlapPrefixLen > 0)).toBe(true);
	});

	it('falls back to plain-text chunking when there are no block elements', () => {
		const chunks = chunkArticleHtml('just loose text with no tags at all here', 'T');
		expect(chunks).toHaveLength(1);
		expect(chunks[0].body).toContain('just loose text');
	});
});

describe('chunkPlainText', () => {
	it('splits on blank lines into paragraphs', () => {
		const chunks = chunkPlainText('para one\n\npara two\n\npara three', '', { targetChars: 5 });
		expect(chunks.map((c) => c.body)).toEqual(['para one', 'para two', 'para three']);
	});

	it('falls back to single-newline split when there are no blank lines', () => {
		const chunks = chunkPlainText('line a\nline b\nline c', '', { targetChars: 5 });
		expect(chunks.map((c) => c.body)).toEqual(['line a', 'line b', 'line c']);
	});

	it('hard-splits a single unbroken blob that exceeds maxChars', () => {
		const blob = 'x'.repeat(1000);
		const chunks = chunkPlainText(blob, '', { targetChars: 300, maxChars: 300 });
		expect(chunks.length).toBeGreaterThan(1);
	});

	it('returns [] for empty or whitespace-only input', () => {
		expect(chunkPlainText('', 'T')).toEqual([]);
		expect(chunkPlainText('   \n\n  ', 'T')).toEqual([]);
	});

	it('uses the title as the breadcrumb', () => {
		const chunks = chunkPlainText('some content', 'My Title');
		expect(chunks[0].breadcrumb).toBe('My Title');
		expect(chunks[0].text.startsWith('My Title\n\n')).toBe(true);
	});
});
