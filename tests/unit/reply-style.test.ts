import { afterEach, describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({ enabled: true }));
vi.mock('#lib/server/endpoints/config.js', async (orig) => ({
	...(await orig<typeof import('#lib/server/endpoints/config.js')>()),
	getCheckInsConfig: () => config,
}));

import {
	CHECK_IN_INSTRUCTIONS,
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
});
