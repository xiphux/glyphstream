import { describe, expect, it } from 'vitest';
import { CONVERSATION_MISSING_NOTICE, noticeMessage } from '$lib/notices';

describe('noticeMessage', () => {
	it('resolves a known notice', () => {
		expect(noticeMessage(CONVERSATION_MISSING_NOTICE)).toBe('That conversation no longer exists.');
	});

	it('returns null for absent or unrecognized values', () => {
		expect(noticeMessage(null)).toBeNull();
		expect(noticeMessage('')).toBeNull();
		expect(noticeMessage('not-a-notice')).toBeNull();
	});

	it('does not resolve inherited Object properties', () => {
		// The value is a raw URL param; a bare index would return Object's own
		// members here, which are not strings and would slip past a null check.
		for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
			expect(noticeMessage(key)).toBeNull();
		}
	});
});
