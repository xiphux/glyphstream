/** Tests for the shared string helpers. */

import { describe, expect, it } from 'vitest';
import { truncateEllipsis } from '$lib/text';

describe('truncateEllipsis', () => {
	it('returns a string within the cap unchanged', () => {
		expect(truncateEllipsis('short', 10)).toBe('short');
		expect(truncateEllipsis('exactly-10', 10)).toBe('exactly-10');
	});

	it('truncates an over-long string to exactly max chars with an ellipsis', () => {
		expect(truncateEllipsis('abcdefghij', 5)).toBe('abcd…');
		expect(truncateEllipsis('abcdefghij', 5)).toHaveLength(5);
	});

	it('trims trailing whitespace before the ellipsis', () => {
		expect(truncateEllipsis('ab       cd', 4)).toBe('ab…');
	});
});
