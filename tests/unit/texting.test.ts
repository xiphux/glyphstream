import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '#lib/server/markdown/render.js';
import { extractSpeaker, splitTopLevelHtml, textingItems } from '#lib/texting.js';
import type { RenderBlock } from '#lib/chat-render.js';

/** Texts as `[speaker, html]` pairs, from markdown rendered the way a stored
 *  reply's `content_html` is. */
async function texts(markdown: string, defaultName = 'Chloe') {
	const html = (await renderMarkdown(markdown))!;
	return textingItems([{ type: 'html', html }], defaultName).map((item) => {
		if (item.kind !== 'text') throw new Error('expected only texts');
		return ['html' in item ? item.html : item.text, item.speaker] as const;
	});
}

describe('splitTopLevelHtml', () => {
	it('splits paragraphs and keeps a fence or list with blank lines in it whole', async () => {
		const html = (await renderMarkdown(
			'hey\n\n```python\na = 1\n\nb = 2\n```\n\n- one\n\n- two\n\nbye',
		))!;
		const chunks = splitTopLevelHtml(html);
		expect(chunks).toHaveLength(4);
		expect(chunks[0]).toBe('<p>hey</p>');
		expect(chunks[1]).toContain('b');
		expect(chunks[1]).toMatch(/^<pre/);
		expect(chunks[2]).toMatch(/^<ul>[\s\S]*two[\s\S]*<\/ul>$/);
		expect(chunks[3]).toBe('<p>bye</p>');
	});

	it('drops thematic breaks and keeps an unclosed tail', () => {
		expect(splitTopLevelHtml('<p>a</p>\n<hr>\n<p>b</p>\n<p>half')).toEqual([
			'<p>a</p>',
			'<p>b</p>',
			'<p>half',
		]);
	});

	it('does not split on a <br> inside a paragraph', () => {
		expect(splitTopLevelHtml('<p>a<br>\nb</p>')).toEqual(['<p>a<br>\nb</p>']);
	});
});

describe('extractSpeaker', () => {
	it.each([
		['<p>Sam: hi</p>', 'Sam'],
		['<p>xX_sam_Xx: hi</p>', 'xX_sam_Xx'],
		['<p>dr. who: hi</p>', 'dr. who'],
		['<p><strong>Sam:</strong> hi</p>', 'Sam'],
		['<p><strong>Sam</strong>: hi</p>', 'Sam'],
	])('reads %s', (html, speaker) => {
		expect(extractSpeaker(html)).toEqual({ speaker, html: '<p>hi</p>' });
	});

	it.each([
		'<p>meet at 3:30 ok</p>',
		'<p>see https://example.com</p>',
		'<p>Sam:hi</p>',
		'<p>this is way too many words: hi</p>',
		'<p>Abcdefghijklmnopqrstuvwxyzabcdefg: hi</p>',
		'<ul><li>Sam: hi</li></ul>',
	])('leaves %s alone', (html) => {
		expect(extractSpeaker(html)).toEqual({ speaker: null, html });
	});
});

describe('textingItems', () => {
	it('gives an unprefixed text to the previous speaker, starting with the assistant', async () => {
		expect(await texts('hey!\n\nSam: yo\n\nwhat is up\n\nJo: hi all')).toEqual([
			['<p>hey!</p>', null],
			['<p>yo</p>', 'Sam'],
			['<p>what is up</p>', 'Sam'],
			['<p>hi all</p>', 'Jo'],
		]);
	});

	it("treats the assistant's own name as no prefix, ignoring case", async () => {
		expect(await texts('Chloe: hey\n\nSam: yo\n\nchloe: stop')).toEqual([
			['<p>hey</p>', null],
			['<p>yo</p>', 'Sam'],
			['<p>stop</p>', null],
		]);
	});

	it('splits plain text the same way, and groups non-text blocks', () => {
		const blocks: RenderBlock[] = [
			{ type: 'plain-text', text: 'Sam: one\n\ntwo' },
			{ type: 'image', mediaId: 'm1' },
			{ type: 'video', mediaId: 'm2' },
			{ type: 'html', html: '<p>three</p>' },
		];
		expect(textingItems(blocks, 'Chloe')).toEqual([
			{ kind: 'text', speaker: 'Sam', text: 'one' },
			{ kind: 'text', speaker: 'Sam', text: 'two' },
			{ kind: 'blocks', blocks: [blocks[1], blocks[2]] },
			{ kind: 'text', speaker: 'Sam', html: '<p>three</p>' },
		]);
	});
});
