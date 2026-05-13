import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB }));
vi.mock('$lib/server/db/client', () => ({
	getDb: () => mocks.testDb,
	closeDb: () => {}
}));

import {
	getUserPreferences,
	parseUserPreferences,
	setUserPreferences
} from '$lib/server/db/queries/user-preferences';
import { users } from '$lib/server/db/schema';

beforeEach(() => {
	mocks.testDb = createTestDb();
});

afterEach(() => {
	closeTestDb();
});

describe('parseUserPreferences', () => {
	it('returns defaults for null', () => {
		expect(parseUserPreferences(null)).toEqual({
			systemPrompt: '',
			enterBehavior: 'send'
		});
	});

	it('returns defaults for invalid JSON without throwing', () => {
		expect(parseUserPreferences('not json {')).toEqual({
			systemPrompt: '',
			enterBehavior: 'send'
		});
	});

	it('returns defaults when parsed value is not an object', () => {
		expect(parseUserPreferences('"a string"')).toEqual({
			systemPrompt: '',
			enterBehavior: 'send'
		});
		expect(parseUserPreferences('42')).toEqual({
			systemPrompt: '',
			enterBehavior: 'send'
		});
		expect(parseUserPreferences('null')).toEqual({
			systemPrompt: '',
			enterBehavior: 'send'
		});
	});

	it('fills missing fields with defaults', () => {
		expect(parseUserPreferences('{"systemPrompt":"hi"}')).toEqual({
			systemPrompt: 'hi',
			enterBehavior: 'send'
		});
		expect(parseUserPreferences('{"enterBehavior":"newline"}')).toEqual({
			systemPrompt: '',
			enterBehavior: 'newline'
		});
	});

	it('coerces invalid field types to defaults', () => {
		// systemPrompt that's a number → default
		expect(
			parseUserPreferences(JSON.stringify({ systemPrompt: 42, enterBehavior: 'send' }))
		).toMatchObject({ systemPrompt: '' });
		// enterBehavior that's an unknown enum value → default
		expect(
			parseUserPreferences(JSON.stringify({ systemPrompt: 'x', enterBehavior: 'bogus' }))
		).toMatchObject({ enterBehavior: 'send' });
	});

	it('ignores extra fields without throwing', () => {
		expect(
			parseUserPreferences(
				JSON.stringify({ systemPrompt: 'hi', enterBehavior: 'newline', futurePref: 'whatever' })
			)
		).toEqual({ systemPrompt: 'hi', enterBehavior: 'newline' });
	});
});

describe('getUserPreferences', () => {
	it('returns defaults for a user with no preferences row value', () => {
		const u = seedUser();
		expect(getUserPreferences(u.id)).toEqual({
			systemPrompt: '',
			enterBehavior: 'send'
		});
	});

	it('returns null for an unknown user id', () => {
		expect(getUserPreferences('does-not-exist')).toBeNull();
	});

	it('returns the persisted values when set', () => {
		const u = seedUser();
		setUserPreferences(u.id, { systemPrompt: 'be brief', enterBehavior: 'newline' });
		expect(getUserPreferences(u.id)).toEqual({
			systemPrompt: 'be brief',
			enterBehavior: 'newline'
		});
	});
});

describe('setUserPreferences', () => {
	it('partial updates leave untouched fields alone', () => {
		const u = seedUser();
		setUserPreferences(u.id, { systemPrompt: 'first prompt', enterBehavior: 'newline' });
		// Update only the prompt — enterBehavior should remain "newline".
		setUserPreferences(u.id, { systemPrompt: 'updated prompt' });
		expect(getUserPreferences(u.id)).toEqual({
			systemPrompt: 'updated prompt',
			enterBehavior: 'newline'
		});
	});

	it('rejects unknown enterBehavior in the patch without affecting prior value', () => {
		const u = seedUser();
		setUserPreferences(u.id, { enterBehavior: 'newline' });
		// @ts-expect-error testing runtime defensiveness against bad input
		setUserPreferences(u.id, { enterBehavior: 'whatever' });
		expect(getUserPreferences(u.id)?.enterBehavior).toBe('newline');
	});

	it('writes a clean JSON blob (no schema drift across updates)', () => {
		const u = seedUser();
		setUserPreferences(u.id, { systemPrompt: 'x', enterBehavior: 'send' });
		const row = mocks.testDb
			.select({ preferencesJson: users.preferencesJson })
			.from(users)
			.where(eq(users.id, u.id))
			.get();
		const parsed = JSON.parse(row?.preferencesJson ?? '{}');
		// Exactly the two known fields, no extra junk.
		expect(Object.keys(parsed).sort()).toEqual(['enterBehavior', 'systemPrompt']);
	});

	it('returns the merged object so callers can sync state without a follow-up read', () => {
		const u = seedUser();
		const next = setUserPreferences(u.id, { systemPrompt: 'hello' });
		expect(next).toEqual({ systemPrompt: 'hello', enterBehavior: 'send' });
	});
});
