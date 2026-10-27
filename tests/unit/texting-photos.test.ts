import { describe, expect, it } from 'vitest';
import { developedPhotos, photoChain, photoMarkers } from '#lib/texting-photos.js';
import type { ChatMessage, MessagePart, PhotoOrigin } from '#lib/types/api.js';

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

const user = msg('u1', 'user', [{ type: 'text', text: 'send pics' }]);
const reply = msg(
	'r1',
	'assistant',
	[{ type: 'text', text: 'ok\n\n[photo: one]\n\nSam: [photo: two]' }],
	'<p>ok</p>\n<p>[photo: one]</p>\n<p>Sam: [photo: two]</p>',
);
const photo = (id: string, origin: PhotoOrigin) =>
	msg(id, 'assistant', [{ type: 'image', mediaId: `media-${id}`, photo: origin }]);
const failed = msg('f1', 'assistant', [{ type: 'error', message: 'out of memory' }]);

describe('photoChain', () => {
	it('develops the first photo under the reply itself', () => {
		expect(photoChain([user, reply])).toEqual({
			replyId: 'r1',
			anchorId: 'r1',
			leafPhoto: null,
			failedLeafId: null,
		});
	});

	it('chains the next photo under the last one, which can be developed again', () => {
		const p0 = photo('p0', { sourceMessageId: 'r1', index: 0 });
		expect(photoChain([user, reply, p0])).toEqual({
			replyId: 'r1',
			anchorId: 'p0',
			leafPhoto: p0,
			failedLeafId: null,
		});
	});

	it('lets the next attempt take over from a failed one', () => {
		const p0 = photo('p0', { sourceMessageId: 'r1', index: 0 });
		expect(photoChain([user, reply, p0, failed])).toEqual({
			replyId: 'r1',
			anchorId: 'p0',
			leafPhoto: null,
			failedLeafId: 'f1',
		});
	});

	it('offers nothing once the thread has moved past the reply', () => {
		expect(photoChain([user, reply, msg('u2', 'user', [{ type: 'text', text: 'nice' }])])).toBe(
			null,
		);
	});

	it("offers nothing when a photo at the end isn't the reply's own", () => {
		const stray = photo('p9', { sourceMessageId: 'elsewhere', index: 0 });
		expect(photoChain([user, reply, stray])).toBe(null);
	});
});

describe('developedPhotos', () => {
	it('groups the arrived photos by the reply that sent them', () => {
		const p0 = photo('p0', { sourceMessageId: 'r1', index: 1 });
		expect(developedPhotos([user, reply, p0])).toEqual(new Map([['r1', new Set([1])]]));
	});
});

describe('photoMarkers', () => {
	it("numbers a reply's markers the way its bubbles do, with each sender", () => {
		expect(photoMarkers(reply, 'Chloe')).toEqual([
			{ index: 0, description: 'one', speaker: null },
			{ index: 1, description: 'two', speaker: 'Sam' },
		]);
	});
});
