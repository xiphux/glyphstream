import { describe, expect, it } from 'vitest';
import { photoMarkers, splitAtPhotos } from '#lib/texting-photos.js';
import type { RenderBlock } from '#lib/chat-render.js';
import { textingItems, withoutCheckInMarkers } from '#lib/texting.js';
import { renderMarkdown } from '#lib/server/markdown/render.js';
import type { ChatMessage, MessagePart } from '#lib/types/api.js';

function msg(id: string, role: ChatMessage['role'], parts: MessagePart[], html?: string) {
	return {
		id,
		role,
		parts,
		contentHtml: html ?? null,
		reasoningText: null,
		finishReason: null,
		modelUsed: null,
		tokensIn: null,
		tokensOut: null,
		genMs: null,
		createdAt: 0,
	} satisfies ChatMessage;
}

const reply = msg(
	'r1',
	'assistant',
	[{ type: 'text', text: 'ok\n\n[photo: one]\n\nSam: [photo: two]' }],
	'<p>ok</p>\n<p>[photo: one]</p>\n<p>Sam: [photo: two]</p>',
);

describe('photoMarkers', () => {
	it("numbers a reply's markers the way its bubbles do, with each sender", () => {
		expect(photoMarkers(reply, 'Chloe')).toEqual([
			{ index: 0, description: 'one', speaker: null },
			{ index: 1, description: 'two', speaker: 'Sam' },
		]);
	});
});

describe('splitAtPhotos', () => {
	const html = (h: string): RenderBlock => ({ type: 'html', html: h });

	it('cuts a reply around its markers, numbered as the texting style numbers them', () => {
		const blocks = [
			html('<p>here it is</p>\n<p>[photo: one]</p>\n<p>and</p>\n<p>Sam: [photo: two]</p>'),
		];
		expect(splitAtPhotos(blocks)).toEqual([
			{ kind: 'blocks', blocks: [html('<p>here it is</p>')] },
			{ kind: 'photo', index: 0, description: 'one' },
			{ kind: 'blocks', blocks: [html('<p>and</p>')] },
			{ kind: 'photo', index: 1, description: 'two' },
		]);
		// The same numbers the server stores versions against.
		expect(
			photoMarkers(
				msg(
					'r',
					'assistant',
					[{ type: 'text', text: 'x' }],
					blocks[0].type === 'html' ? blocks[0].html : '',
				),
				'',
			).map((m) => m.index),
		).toEqual([0, 1]);
	});

	it('leaves a reply with no markers as it was', () => {
		const blocks = [html('<p>just text</p>'), { type: 'image', mediaId: 'm' } as RenderBlock];
		expect(splitAtPhotos(blocks)).toEqual([{ kind: 'blocks', blocks }]);
	});

	it('keeps a reply’s dividers, with or without a photo in it', () => {
		const plain = html('<p>one</p>\n<hr>\n<p>two</p>');
		// Untouched: the very same block.
		expect(splitAtPhotos([plain])[0]).toEqual({ kind: 'blocks', blocks: [plain] });
		expect((splitAtPhotos([plain])[0] as { blocks: RenderBlock[] }).blocks[0]).toBe(plain);
		expect(
			splitAtPhotos([html('<p>one</p>\n<hr>\n<p>[photo: a cat]</p>\n<hr>\n<p>two</p>')]),
		).toEqual([
			{ kind: 'blocks', blocks: [html('<p>one</p>\n<hr>')] },
			{ kind: 'photo', index: 0, description: 'a cat' },
			{ kind: 'blocks', blocks: [html('<hr>\n<p>two</p>')] },
		]);
	});

	it('reads plain text the same way', () => {
		expect(splitAtPhotos([{ type: 'plain-text', text: 'look\n\n[photo: a cat]' }])).toEqual([
			{ kind: 'blocks', blocks: [{ type: 'plain-text', text: 'look' }] },
			{ kind: 'photo', index: 0, description: 'a cat' },
		]);
	});

	it("doesn't hold back a live code line or list item that ends in [", () => {
		const code = html('<p>try</p>\n<pre><code>x = {"a": [</code></pre>');
		expect(splitAtPhotos([code], true)).toEqual([
			{ kind: 'blocks', blocks: [html('<p>try</p>\n<pre><code>x = {"a": [</code></pre>')] },
		]);
		const list = html('<ul>\n<li>Label: [</li>\n</ul>');
		expect(splitAtPhotos([list], true)).toEqual([{ kind: 'blocks', blocks: [list] }]);
	});

	it('holds back a marker still being written in a live reply', () => {
		const live = [html('<p>look</p>\n<p>[photo: a cat on</p>')];
		expect(splitAtPhotos(live, true)).toEqual([{ kind: 'blocks', blocks: [html('<p>look</p>')] }]);
		// Stored, it's just text: a marker never closed isn't one.
		expect(splitAtPhotos(live)).toEqual([{ kind: 'blocks', blocks: live }]);
		expect(splitAtPhotos([{ type: 'plain-text', text: 'look\n\n[pho' }], true)).toEqual([
			{ kind: 'blocks', blocks: [{ type: 'plain-text', text: 'look' }] },
		]);
	});
});

// A developed photo is stored against its number, which the server reads with
// `photoMarkers` (`textingItems`) and a standard reply draws with
// `splitAtPhotos` — the two must count alike for every shape a reply takes, or
// stored photos land in the wrong places.
describe('photo numbering, standard against texting', () => {
	const REPLIES = [
		'here\n\n[photo: one]\n\nand\n\n[photo: two]',
		'Sam: [photo: a speaker’s]\n\nJo: hi\n\n*[photo: in italics]*\n\n**[photo: in bold]**',
		'one\n\n---\n\n[photo: after a divider]\n\n- a list\n- [photo: inside a list]',
		'```\n[photo: in code]\n```\n\n[photo: real]',
		'[photo: a]\n[photo: b]\n\n[photo: ]\n\n[photo: c]',
		'bye\n\n[photo: before a check-in]\n\n[later 1h: ask]',
	];

	it.each(REPLIES)('agrees on %j', async (markdown) => {
		const rendered = [{ type: 'html', html: await renderMarkdown(markdown) }] as RenderBlock[];
		const plain = [{ type: 'plain-text', text: markdown }] as RenderBlock[];
		for (const blocks of [rendered, plain]) {
			const texting = textingItems(blocks, 'Chloe').flatMap((item) =>
				item.kind === 'photo' ? [{ index: item.index, description: item.description }] : [],
			);
			const standard = splitAtPhotos(withoutCheckInMarkers(blocks)).flatMap((s) =>
				s.kind === 'photo' ? [{ index: s.index, description: s.description }] : [],
			);
			expect(standard).toEqual(texting);
		}
	});
});
