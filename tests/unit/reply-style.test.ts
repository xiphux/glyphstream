import { afterEach, describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({ enabled: true }));
vi.mock('#lib/server/endpoints/config.js', async (orig) => ({
	...(await orig<typeof import('#lib/server/endpoints/config.js')>()),
	getCheckInsConfig: () => config,
}));

import {
	CHECK_IN_INSTRUCTIONS,
	characterInstructions,
	PHOTO_INSTRUCTIONS,
	replyStyleInstructions,
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

	it('words check-ins for a character after the character format', () => {
		expect(replyStyleInstructions('character', true)).toBe(
			`${characterInstructions('texting')} ${CHECK_IN_INSTRUCTIONS.character}`,
		);
		expect(replyStyleInstructions('character', false)).toBe(characterInstructions('texting'));
	});

	it('leaves check-ins out when the operator turned them off', () => {
		config.enabled = false;
		expect(replyStyleInstructions('standard', true)).toBeNull();
		expect(replyStyleInstructions('character', true)).toBe(characterInstructions('texting'));
	});

	it('tells a chat about photos only when it may send them, in its style', () => {
		expect(replyStyleInstructions('standard', false, true)).toBe(PHOTO_INSTRUCTIONS.standard);
		expect(replyStyleInstructions('character', true, true)).toBe(
			`${characterInstructions('texting')} ${PHOTO_INSTRUCTIONS.character} ${CHECK_IN_INSTRUCTIONS.character}`,
		);
	});

	it('describes both scenes whichever a character starts in, and says which', () => {
		const texting = replyStyleInstructions('character', false, false, 'texting')!;
		const inPerson = replyStyleInstructions('character', false, false, 'in_person')!;
		for (const block of [texting, inPerson]) {
			expect(block).toContain('[in person]');
			expect(block).toContain('[texting]');
		}
		expect(texting).toMatch(/starts over text\.$/);
		expect(inPerson).toMatch(/starts in person\.$/);
		// Only the closing sentence differs: everything a scene change could
		// touch is stated the same either way.
		expect(texting.replace(/[^.]*\.$/, '')).toBe(inPerson.replace(/[^.]*\.$/, ''));
	});
});
