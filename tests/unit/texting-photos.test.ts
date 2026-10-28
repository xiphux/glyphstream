import { describe, expect, it } from 'vitest';
import { photoMarkers, splitAtPhotos } from '#lib/texting-photos.js';
import type { RenderBlock } from '#lib/chat-render.js';
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

	it('reads plain text the same way', () => {
		expect(splitAtPhotos([{ type: 'plain-text', text: 'look\n\n[photo: a cat]' }])).toEqual([
			{ kind: 'blocks', blocks: [{ type: 'plain-text', text: 'look' }] },
			{ kind: 'photo', index: 0, description: 'a cat' },
		]);
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
