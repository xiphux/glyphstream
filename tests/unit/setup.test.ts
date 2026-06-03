import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({
	testDb: null as unknown as TestDB,
	token: '',
}));
vi.mock('$lib/server/db/client', () => ({
	getDb: () => mocks.testDb,
	closeDb: () => {},
}));
vi.mock('$lib/server/env', () => ({
	setupToken: () => mocks.token,
}));

import { setupGate } from '$lib/server/auth/setup';

beforeEach(() => {
	mocks.testDb = createTestDb();
	mocks.token = '';
});

afterEach(() => {
	closeTestDb();
});

function urlWith(query: Record<string, string> = {}): URL {
	const u = new URL('http://localhost/setup');
	for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
	return u;
}

describe('setupGate', () => {
	it('returns "allowed" when no users exist and no token is required', () => {
		expect(setupGate(urlWith())).toBe('allowed');
	});

	it('returns "closed" as soon as a user exists', () => {
		seedUser();
		expect(setupGate(urlWith())).toBe('closed');
	});

	it('returns "closed" even when a matching token is supplied', () => {
		// User-count check wins; the wizard is closed regardless of token.
		mocks.token = 'secret';
		seedUser();
		expect(setupGate(urlWith({ token: 'secret' }))).toBe('closed');
	});

	it('returns "needs-token" when SETUP_TOKEN is set and ?token is missing', () => {
		mocks.token = 'secret';
		expect(setupGate(urlWith())).toBe('needs-token');
	});

	it('returns "needs-token" when ?token doesn\'t match', () => {
		mocks.token = 'secret';
		expect(setupGate(urlWith({ token: 'wrong' }))).toBe('needs-token');
	});

	it('returns "needs-token" for a same-prefix-different-length token', () => {
		mocks.token = 'secret';
		expect(setupGate(urlWith({ token: 'secret-extra' }))).toBe('needs-token');
	});

	it('returns "allowed" when the matching token is supplied', () => {
		mocks.token = 'secret';
		expect(setupGate(urlWith({ token: 'secret' }))).toBe('allowed');
	});
});
