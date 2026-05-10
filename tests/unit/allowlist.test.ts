import { describe, expect, it, beforeEach, vi } from 'vitest';

// Mock the env so each test controls what ALLOWED_GITHUB_USER_IDS returns.
const mocks = vi.hoisted(() => ({ raw: '' }));
vi.mock('$lib/server/env', () => ({
	allowedGithubUserIdsRaw: () => mocks.raw
}));

import { isAllowed, loadAllowlist, resetAllowlist } from '$lib/server/auth/allowlist';

describe('allowlist', () => {
	beforeEach(() => {
		resetAllowlist();
	});

	it('allows IDs in the comma-separated env var', () => {
		mocks.raw = '12345,67890';
		expect(isAllowed(12345)).toBe(true);
		expect(isAllowed(67890)).toBe(true);
	});

	it('blocks IDs not in the env var', () => {
		mocks.raw = '12345';
		expect(isAllowed(99999)).toBe(false);
	});

	it('fails closed when env var is empty', () => {
		// Self-hosted public-facing app default: empty allowlist = no logins.
		mocks.raw = '';
		expect(isAllowed(12345)).toBe(false);
		expect(loadAllowlist().size).toBe(0);
	});

	it('handles whitespace around entries', () => {
		mocks.raw = '  12345 ,  67890 ';
		expect(isAllowed(12345)).toBe(true);
		expect(isAllowed(67890)).toBe(true);
	});

	it('rejects non-numeric entries', () => {
		mocks.raw = '12345,not-a-number';
		expect(() => loadAllowlist()).toThrow(/invalid entry/);
	});

	it('rejects negative or zero IDs', () => {
		mocks.raw = '0';
		expect(() => loadAllowlist()).toThrow();
		mocks.raw = '-1';
		expect(() => loadAllowlist()).toThrow();
	});

	it('rejects floats / mixed numeric strings', () => {
		mocks.raw = '12345.5';
		expect(() => loadAllowlist()).toThrow();
		// Number.parseInt would happily parse "123abc" as 123, but the
		// String(n) === trimmed re-check catches that.
		mocks.raw = '123abc';
		expect(() => loadAllowlist()).toThrow();
	});

	it('caches the parsed Set across calls', () => {
		mocks.raw = '12345';
		const a = loadAllowlist();
		const b = loadAllowlist();
		expect(a).toBe(b); // same identity = cached
	});
});
