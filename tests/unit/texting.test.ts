import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '#lib/server/markdown/render.js';
import { extractSpeaker, photoDescription, splitTopLevelHtml, textingItems } from '#lib/texting.js';
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

	it("gives the model's own reaction to the model, whoever spoke last", () => {
		const blocks: RenderBlock[] = [
			{ type: 'html', html: '<p>Sam: yo</p>' },
			{ type: 'plain-text', text: '👋', ownReaction: true },
			{ type: 'html', html: '<p>so?</p>' },
		];
		expect(textingItems(blocks, 'Chloe')).toEqual([
			{ kind: 'text', speaker: 'Sam', html: '<p>yo</p>' },
			{ kind: 'text', speaker: null, text: '👋' },
			{ kind: 'text', speaker: null, html: '<p>so?</p>' },
		]);
	});
});

describe('photo markers', () => {
	async function items(markdown: string) {
		const html = (await renderMarkdown(markdown))!;
		return textingItems([{ type: 'html', html }], 'Chloe');
	}

	it('turns a marker text into a numbered photo, from whoever sent it', async () => {
		expect(
			await items('look!\n\n[photo: me at the beach, 3:4]\n\nSam: *[Photo: Sam & the dog]*\n\nlol'),
		).toEqual([
			{ kind: 'text', speaker: null, html: '<p>look!</p>' },
			{ kind: 'photo', speaker: null, description: 'me at the beach, 3:4', index: 0 },
			{ kind: 'photo', speaker: 'Sam', description: 'Sam & the dog', index: 1 },
			{ kind: 'text', speaker: 'Sam', html: '<p>lol</p>' },
		]);
	});

	it('numbers a live reply the same way', () => {
		const blocks: RenderBlock[] = [
			{ type: 'plain-text', text: '[photo: one]\n\nhi\n\n**[photo: two]**' },
		];
		expect(textingItems(blocks, 'Chloe').filter((i) => i.kind === 'photo')).toEqual([
			{ kind: 'photo', speaker: null, description: 'one', index: 0 },
			{ kind: 'photo', speaker: null, description: 'two', index: 1 },
		]);
	});

	it.each([
		'here you go [photo: a cat]',
		'[photo: ]',
		'[photo: a cat] and more',
		'photo: a cat',
		// Two markers run into one paragraph: not one photo of "a cat]\n[photo: a dog".
		'[photo: a cat]\n[photo: a dog]',
		'[photo: a cat] lol [jk]',
	])('leaves %s as a text', async (markdown) => {
		const [item] = await items(markdown);
		expect(item.kind).toBe('text');
	});

	it('reads markup out of the description', () => {
		expect(photoDescription({ html: '<p>[photo: a <em>very</em> &quot;big&quot; dog]</p>' })).toBe(
			'a very "big" dog',
		);
	});

	it('gives a developed photo to the speaker it carries', () => {
		const photo = { sourceMessageId: 'r1', index: 0, speaker: 'Sam' };
		const blocks: RenderBlock[] = [{ type: 'image', mediaId: 'm1', photo }];
		expect(textingItems(blocks, 'Chloe')).toEqual([
			{ kind: 'sent-photo', speaker: 'Sam', block: blocks[0] },
		]);
	});
});
