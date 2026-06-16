import { describe, expect, it } from 'vitest';
import { parseIdentityInput } from '$lib/server/auth/identity-input';

/** error() throws an HttpError with a numeric `status`. */
function statusOf(fn: () => unknown): number | undefined {
	try {
		fn();
	} catch (e) {
		return (e as { status?: number }).status;
	}
	return undefined;
}

describe('parseIdentityInput', () => {
	it('trims the display name and email', () => {
		expect(parseIdentityInput({ displayName: '  Ada  ', email: '  ada@x.test ' })).toEqual({
			displayName: 'Ada',
			email: 'ada@x.test',
		});
	});

	it('normalizes a blank/absent email to null', () => {
		expect(parseIdentityInput({ displayName: 'Ada', email: '   ' }).email).toBeNull();
		expect(parseIdentityInput({ displayName: 'Ada' }).email).toBeNull();
	});

	it('throws 400 when the display name is missing or blank', () => {
		expect(statusOf(() => parseIdentityInput({ email: 'a@x.test' }))).toBe(400);
		expect(statusOf(() => parseIdentityInput({ displayName: '   ' }))).toBe(400);
	});

	it('throws 400 when the display name exceeds 60 chars', () => {
		expect(statusOf(() => parseIdentityInput({ displayName: 'a'.repeat(61) }))).toBe(400);
		expect(parseIdentityInput({ displayName: 'a'.repeat(60) }).displayName).toHaveLength(60);
	});

	it('throws 400 when the email exceeds 120 chars', () => {
		expect(statusOf(() => parseIdentityInput({ displayName: 'Ada', email: 'a'.repeat(121) }))).toBe(
			400,
		);
	});
});
