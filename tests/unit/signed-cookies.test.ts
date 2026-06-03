import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/env', () => ({
	authSecret: () => 'test-secret-do-not-use-in-prod',
}));

import { sign, verify } from '$lib/server/auth/signed-cookies';

describe('signed-cookies', () => {
	it('round-trips a payload', () => {
		const signed = sign({ a: 1, b: 'two' }, 60_000);
		const decoded = verify<{ a: number; b: string }>(signed);
		expect(decoded?.a).toBe(1);
		expect(decoded?.b).toBe('two');
		expect(typeof decoded?.exp).toBe('number');
	});

	it('rejects a payload whose signature was tampered with', () => {
		const signed = sign({ a: 1 }, 60_000);
		const tampered = signed.slice(0, -2) + 'XX';
		expect(verify(tampered)).toBeNull();
	});

	it('rejects a payload whose body was tampered with', () => {
		const signed = sign({ a: 1 }, 60_000);
		const [body, tag] = signed.split('.');
		const fakeBody = Buffer.from('{"a":2,"exp":' + (Date.now() + 60_000) + '}', 'utf8').toString(
			'base64url',
		);
		expect(verify(`${fakeBody}.${tag}`)).toBeNull();
	});

	it('rejects a payload past its expiry', () => {
		const signed = sign({ a: 1 }, -1_000);
		expect(verify(signed)).toBeNull();
	});

	it('rejects empty / missing / malformed input', () => {
		expect(verify(undefined)).toBeNull();
		expect(verify(null)).toBeNull();
		expect(verify('')).toBeNull();
		expect(verify('no-dot')).toBeNull();
		expect(verify('.tag-only')).toBeNull();
		expect(verify('body-only.')).toBeNull();
	});

	it('produces a different signature for different payloads', () => {
		const a = sign({ value: 1 }, 60_000);
		const b = sign({ value: 2 }, 60_000);
		expect(a).not.toBe(b);
	});
});
