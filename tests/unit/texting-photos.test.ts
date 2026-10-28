import { describe, expect, it } from 'vitest';
import { photoMarkers } from '#lib/texting-photos.js';
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
