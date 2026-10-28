import { afterEach, describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({ enabled: true }));
vi.mock('#lib/server/endpoints/config.js', async (orig) => ({
	...(await orig<typeof import('#lib/server/endpoints/config.js')>()),
	getCheckInsConfig: () => config,
}));

import {
	CHECK_IN_INSTRUCTIONS,
	PHOTO_INSTRUCTIONS,
	replyStyleInstructions,
	TEXTING_INSTRUCTIONS,
} from '#lib/server/chat/reply-style.js';

afterEach(() => {
	config.enabled = true;
});

describe('replyStyleInstructions', () => {
	it('adds nothing to a standard chat that can’t check in', () => {
		expect(replyStyleInstructions('standard', false)).toBeNull();
	});

	it('tells a standard chat about check-ins only when it may set them', () => {
		expect(replyStyleInstructions('standard', true)).toBe(CHECK_IN_INSTRUCTIONS.standard);
	});

	it('words check-ins for texting after the texting format', () => {
		expect(replyStyleInstructions('texting', true)).toBe(
			`${TEXTING_INSTRUCTIONS} ${CHECK_IN_INSTRUCTIONS.texting}`,
		);
		expect(replyStyleInstructions('texting', false)).toBe(TEXTING_INSTRUCTIONS);
	});

	it('leaves check-ins out when the operator turned them off', () => {
		config.enabled = false;
		expect(replyStyleInstructions('standard', true)).toBeNull();
		expect(replyStyleInstructions('texting', true)).toBe(TEXTING_INSTRUCTIONS);
	});

	it('tells a chat about photos only when it may send them, in its style', () => {
		expect(replyStyleInstructions('standard', false, true)).toBe(PHOTO_INSTRUCTIONS.standard);
		expect(replyStyleInstructions('texting', true, true)).toBe(
			`${TEXTING_INSTRUCTIONS} ${PHOTO_INSTRUCTIONS.texting} ${CHECK_IN_INSTRUCTIONS.texting}`,
		);
	});

	// A texting chat's system prompt carried the photo instruction before photos
	// had a setting, and the migration switched those chats on: what they send
	// must not move by a byte, or each one re-prefills its whole history.
	it('gives a texting chat with photos the exact block it sent before the setting', () => {
		expect(replyStyleInstructions('texting', false, true)).toBe(
			"You're texting. Write each text as its own short paragraph, separated by a blank line; " +
				"each paragraph appears as a separate message bubble. Don't put your name in front of your texts. " +
				'To send a text as someone else in the chat, begin it with their name and a colon ("Name: "). ' +
				'A text with no name is from whoever sent the text before it, or from you if it comes first. ' +
				'Never otherwise begin a text with a word followed by a colon. ' +
				'To send a photo, when it fits the moment, write it as a text of its own: ' +
				'[photo: what it shows]. ' +
				"The camera can't see this chat, so describe the picture completely, including how anyone in it looks, " +
				'and give its aspect ratio: 3:4, 2:3 or 9:16 upright; 4:3, 3:2 or 16:9 sideways.',
		);
	});
});
