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
	publicBaseUrl: () => 'https://chat.example.test',
}));

import { setupGate, _resetGeneratedSetupTokenForTests } from '$lib/server/auth/setup';

beforeEach(() => {
	mocks.testDb = createTestDb();
	mocks.token = '';
	_resetGeneratedSetupTokenForTests();
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
	closeTestDb();
	vi.restoreAllMocks();
});

/** Pull the setup URL out of the announcement written to stderr. */
function announcedToken(): string {
	const warn = vi.mocked(console.warn);
	const line = warn.mock.calls.map((c) => String(c[0])).join('\n');
	return new URL(line.match(/https?:\/\/\S+/)![0]).searchParams.get('token')!;
}

function urlWith(query: Record<string, string> = {}): URL {
	const u = new URL('http://localhost/setup');
	for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
	return u;
}

describe('setupGate', () => {
	it('requires a token even when the operator configured none', () => {
		// SETUP_TOKEN used to be opt-in and shipped commented out, so a fresh
		// install served an open wizard — anyone reaching the host before the
		// operator finished could claim the admin account, which then closes
		// /setup structurally against the real operator.
		expect(setupGate(urlWith())).toBe('needs-token');
	});

	it('mints a token, announces it, and accepts it', () => {
		expect(setupGate(urlWith())).toBe('needs-token');
		const minted = announcedToken();
		expect(minted).toHaveLength(32); // 24 random bytes, base64url
		expect(setupGate(urlWith({ token: minted }))).toBe('allowed');
	});

	it('mints once per process, not once per request', () => {
		setupGate(urlWith());
		const first = announcedToken();
		setupGate(urlWith());
		setupGate(urlWith({ token: 'nope' }));
		expect(announcedToken()).toBe(first);
		expect(vi.mocked(console.warn).mock.calls).toHaveLength(1);
	});

	it('never mints or announces once setup is closed', () => {
		// An established instance should generate nothing and log nothing.
		seedUser();
		expect(setupGate(urlWith())).toBe('closed');
		expect(vi.mocked(console.warn)).not.toHaveBeenCalled();
	});

	it('prefers a configured SETUP_TOKEN over minting one', () => {
		mocks.token = 'secret';
		expect(setupGate(urlWith({ token: 'secret' }))).toBe('allowed');
		expect(vi.mocked(console.warn)).not.toHaveBeenCalled();
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
