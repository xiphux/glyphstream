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
	composePersonaSystemPrompt,
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

const EMPTY_PREFS = {
	name: '',
	aboutYou: '',
	customInstructions: '',
	enterBehavior: 'send' as const
};

describe('parseUserPreferences', () => {
	it('returns defaults for null', () => {
		expect(parseUserPreferences(null)).toEqual(EMPTY_PREFS);
	});

	it('returns defaults for invalid JSON without throwing', () => {
		expect(parseUserPreferences('not json {')).toEqual(EMPTY_PREFS);
	});

	it('returns defaults when parsed value is not an object', () => {
		expect(parseUserPreferences('"a string"')).toEqual(EMPTY_PREFS);
		expect(parseUserPreferences('42')).toEqual(EMPTY_PREFS);
		expect(parseUserPreferences('null')).toEqual(EMPTY_PREFS);
	});

	it('fills missing fields with defaults', () => {
		expect(parseUserPreferences('{"name":"Chris"}')).toMatchObject({
			name: 'Chris',
			aboutYou: '',
			customInstructions: '',
			enterBehavior: 'send'
		});
		expect(parseUserPreferences('{"enterBehavior":"newline"}')).toMatchObject({
			enterBehavior: 'newline'
		});
	});

	it('coerces invalid field types to defaults', () => {
		expect(
			parseUserPreferences(JSON.stringify({ name: 42, enterBehavior: 'send' }))
		).toMatchObject({ name: '' });
		expect(
			parseUserPreferences(
				JSON.stringify({ aboutYou: ['array', 'instead', 'of', 'string'] })
			)
		).toMatchObject({ aboutYou: '' });
		expect(
			parseUserPreferences(JSON.stringify({ enterBehavior: 'bogus' }))
		).toMatchObject({ enterBehavior: 'send' });
	});

	it('ignores extra fields without throwing', () => {
		const blob = JSON.stringify({
			name: 'Chris',
			aboutYou: 'engineer',
			customInstructions: 'be brief',
			enterBehavior: 'newline',
			// Legacy / unknown shapes don't pollute the parsed object.
			systemPrompt: 'left over from earlier schema',
			futurePref: 'whatever'
		});
		expect(parseUserPreferences(blob)).toEqual({
			name: 'Chris',
			aboutYou: 'engineer',
			customInstructions: 'be brief',
			enterBehavior: 'newline'
		});
	});
});

describe('getUserPreferences', () => {
	it('returns defaults for a user with no preferences row value', () => {
		const u = seedUser();
		expect(getUserPreferences(u.id)).toEqual(EMPTY_PREFS);
	});

	it('returns null for an unknown user id', () => {
		expect(getUserPreferences('does-not-exist')).toBeNull();
	});

	it('returns the persisted values when set', () => {
		const u = seedUser();
		setUserPreferences(u.id, {
			name: 'Chris',
			aboutYou: 'software engineer',
			customInstructions: 'be concise',
			enterBehavior: 'newline'
		});
		expect(getUserPreferences(u.id)).toEqual({
			name: 'Chris',
			aboutYou: 'software engineer',
			customInstructions: 'be concise',
			enterBehavior: 'newline'
		});
	});
});

describe('setUserPreferences', () => {
	it('partial updates leave untouched fields alone', () => {
		const u = seedUser();
		setUserPreferences(u.id, {
			name: 'Chris',
			aboutYou: 'engineer',
			enterBehavior: 'newline'
		});
		// Update only the name — other fields preserved.
		setUserPreferences(u.id, { name: 'C' });
		expect(getUserPreferences(u.id)).toEqual({
			name: 'C',
			aboutYou: 'engineer',
			customInstructions: '',
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
		setUserPreferences(u.id, { name: 'Chris' });
		const row = mocks.testDb
			.select({ preferencesJson: users.preferencesJson })
			.from(users)
			.where(eq(users.id, u.id))
			.get();
		const parsed = JSON.parse(row?.preferencesJson ?? '{}');
		// Exactly the four known fields, no extras leaking through.
		expect(Object.keys(parsed).sort()).toEqual([
			'aboutYou',
			'customInstructions',
			'enterBehavior',
			'name'
		]);
	});

	it('returns the merged object so callers can sync state without a follow-up read', () => {
		const u = seedUser();
		const next = setUserPreferences(u.id, { name: 'Chris' });
		expect(next).toEqual({
			name: 'Chris',
			aboutYou: '',
			customInstructions: '',
			enterBehavior: 'send'
		});
	});
});

describe('composePersonaSystemPrompt', () => {
	it('returns null when all three personalization fields are empty', () => {
		expect(composePersonaSystemPrompt(EMPTY_PREFS)).toBeNull();
	});

	it('includes only the name when only name is set', () => {
		const out = composePersonaSystemPrompt({ ...EMPTY_PREFS, name: 'Chris' });
		expect(out).toContain('name is Chris');
		expect(out).not.toContain('About the user');
		expect(out).not.toContain('Additional instructions');
	});

	it('omits empty / whitespace-only fields entirely', () => {
		// Whitespace-only counts as empty — no "Name: " followed by blanks.
		const out = composePersonaSystemPrompt({
			...EMPTY_PREFS,
			name: '   ',
			aboutYou: 'real content',
			customInstructions: '\n\n'
		});
		expect(out).not.toContain('name is');
		expect(out).toContain('About the user');
		expect(out).not.toContain('Additional instructions');
	});

	it('composes all three fields with section labels', () => {
		const out = composePersonaSystemPrompt({
			...EMPTY_PREFS,
			name: 'Chris',
			aboutYou: 'software engineer',
			customInstructions: 'be concise'
		});
		expect(out).toContain("user's name is Chris");
		expect(out).toContain('About the user:\nsoftware engineer');
		expect(out).toContain('Additional instructions:\nbe concise');
		// Sections separated by blank lines so the model gets visual structure.
		expect(out).toContain('\n\n');
	});

	it('section order is name → aboutYou → customInstructions', () => {
		const out = composePersonaSystemPrompt({
			...EMPTY_PREFS,
			name: 'A',
			aboutYou: 'B',
			customInstructions: 'C'
		});
		const nameIdx = out!.indexOf('A');
		const aboutIdx = out!.indexOf('B');
		const customIdx = out!.indexOf('C');
		expect(nameIdx).toBeLessThan(aboutIdx);
		expect(aboutIdx).toBeLessThan(customIdx);
	});
});
