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
	enterBehavior: 'send' as const,
	showGreeting: true,
	theme: 'glyphstream' as const,
	colorScheme: 'system' as const,
	notificationsEnabled: false,
	notificationsShowContent: false,
	notificationsForegroundToast: true,
	favoriteModels: [] as string[],
	trustedMcpTools: [] as string[]
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
			...EMPTY_PREFS,
			name: 'Chris',
			aboutYou: 'engineer',
			customInstructions: 'be brief',
			enterBehavior: 'newline'
		});
	});

	it('parses favoriteModels as a string array', () => {
		expect(
			parseUserPreferences(
				JSON.stringify({ favoriteModels: ['openai::gpt-4', 'custom::abc'] })
			)
		).toMatchObject({ favoriteModels: ['openai::gpt-4', 'custom::abc'] });
	});

	it('falls back to the default for a malformed favoriteModels (mixed types)', () => {
		// A mixed array indicates an upstream bug rather than recoverable
		// noise — silently filtering bad elements would hide it. Fall back
		// to the default empty array.
		expect(
			parseUserPreferences(
				JSON.stringify({ favoriteModels: ['openai::gpt-4', 42, null] })
			)
		).toMatchObject({ favoriteModels: [] });
	});

	it('falls back to the default for a non-array favoriteModels', () => {
		expect(
			parseUserPreferences(JSON.stringify({ favoriteModels: 'not-an-array' }))
		).toMatchObject({ favoriteModels: [] });
		expect(
			parseUserPreferences(JSON.stringify({ favoriteModels: null }))
		).toMatchObject({ favoriteModels: [] });
	});

	it('de-dupes favoriteModels while preserving first-occurrence order', () => {
		expect(
			parseUserPreferences(
				JSON.stringify({ favoriteModels: ['a', 'b', 'a', 'c', 'b'] })
			)
		).toMatchObject({ favoriteModels: ['a', 'b', 'c'] });
	});

	it('parses notification preference fields with type coercion', () => {
		expect(
			parseUserPreferences(
				JSON.stringify({
					notificationsEnabled: true,
					notificationsShowContent: true,
					notificationsForegroundToast: false
				})
			)
		).toMatchObject({
			notificationsEnabled: true,
			notificationsShowContent: true,
			notificationsForegroundToast: false
		});
		// Non-boolean values fall back to defaults.
		expect(
			parseUserPreferences(
				JSON.stringify({
					notificationsEnabled: 'yes',
					notificationsShowContent: 1,
					notificationsForegroundToast: null
				})
			)
		).toMatchObject({
			notificationsEnabled: false,
			notificationsShowContent: false,
			notificationsForegroundToast: true
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
			...EMPTY_PREFS,
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
			...EMPTY_PREFS,
			name: 'C',
			aboutYou: 'engineer',
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
		// Exactly the known fields, no extras leaking through.
		expect(Object.keys(parsed).sort()).toEqual([
			'aboutYou',
			'colorScheme',
			'customInstructions',
			'enterBehavior',
			'favoriteModels',
			'name',
			'notificationsEnabled',
			'notificationsForegroundToast',
			'notificationsShowContent',
			'showGreeting',
			'theme',
			'trustedMcpTools'
		]);
	});

	it('returns the merged object so callers can sync state without a follow-up read', () => {
		const u = seedUser();
		const next = setUserPreferences(u.id, { name: 'Chris' });
		expect(next).toEqual({
			...EMPTY_PREFS,
			name: 'Chris'
		});
	});

	it('persists notification preference toggles', () => {
		const u = seedUser();
		setUserPreferences(u.id, {
			notificationsEnabled: true,
			notificationsShowContent: true,
			notificationsForegroundToast: false
		});
		expect(getUserPreferences(u.id)).toMatchObject({
			notificationsEnabled: true,
			notificationsShowContent: true,
			notificationsForegroundToast: false
		});
		// Partial update leaves other notification fields alone.
		setUserPreferences(u.id, { notificationsShowContent: false });
		expect(getUserPreferences(u.id)).toMatchObject({
			notificationsEnabled: true,
			notificationsShowContent: false,
			notificationsForegroundToast: false
		});
	});

	it('persists favoriteModels and accepts an empty array as a valid clear', () => {
		const u = seedUser();
		setUserPreferences(u.id, { favoriteModels: ['openai::gpt-4', 'custom::abc'] });
		expect(getUserPreferences(u.id)?.favoriteModels).toEqual([
			'openai::gpt-4',
			'custom::abc'
		]);
		setUserPreferences(u.id, { favoriteModels: [] });
		expect(getUserPreferences(u.id)?.favoriteModels).toEqual([]);
	});

	it('persists showGreeting toggles', () => {
		const u = seedUser();
		setUserPreferences(u.id, { showGreeting: false });
		expect(getUserPreferences(u.id)?.showGreeting).toBe(false);
		setUserPreferences(u.id, { showGreeting: true });
		expect(getUserPreferences(u.id)?.showGreeting).toBe(true);
	});

	it('persists trustedMcpTools — MCP "always allow" grant storage', () => {
		// Backing store for the PUT /api/user/trusted-tools/:name +
		// /settings/permissions revoke endpoints. The endpoints just
		// merge / splice the array and re-write; this confirms the
		// underlying read-modify-write round-trips cleanly.
		const u = seedUser();
		setUserPreferences(u.id, {
			trustedMcpTools: ['mcp__fs__read_file', 'mcp__fs__list_directory']
		});
		expect(getUserPreferences(u.id)?.trustedMcpTools).toEqual([
			'mcp__fs__read_file',
			'mcp__fs__list_directory'
		]);
		// Revoke: filter out the targeted one + write back. Mirrors the
		// DELETE handler's array splice.
		setUserPreferences(u.id, {
			trustedMcpTools: ['mcp__fs__list_directory']
		});
		expect(getUserPreferences(u.id)?.trustedMcpTools).toEqual([
			'mcp__fs__list_directory'
		]);
		// Empty array is a valid clear (last revoke).
		setUserPreferences(u.id, { trustedMcpTools: [] });
		expect(getUserPreferences(u.id)?.trustedMcpTools).toEqual([]);
	});

	it('de-dupes trustedMcpTools while preserving insertion order', () => {
		// The PUT endpoint's idempotency contract: re-granting an
		// already-trusted tool must not duplicate it. The underlying
		// coercer is the same shape as favoriteModels — a defensive
		// de-dupe runs on every write.
		const u = seedUser();
		setUserPreferences(u.id, {
			trustedMcpTools: ['mcp__fs__read_file', 'mcp__fs__read_file', 'mcp__linear__create_issue']
		});
		expect(getUserPreferences(u.id)?.trustedMcpTools).toEqual([
			'mcp__fs__read_file',
			'mcp__linear__create_issue'
		]);
	});
});

describe('composePersonaSystemPrompt', () => {
	it('returns null when all personalization fields and memories are empty', () => {
		expect(composePersonaSystemPrompt(EMPTY_PREFS)).toBeNull();
		expect(composePersonaSystemPrompt(EMPTY_PREFS, [])).toBeNull();
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

	it('appends a Saved memories section after the persona fields', () => {
		const out = composePersonaSystemPrompt(
			{ ...EMPTY_PREFS, name: 'Chris' },
			[
				{ id: 'm1', content: 'prefers metric units', createdAt: 0, updatedAt: 0 },
				{ id: 'm2', content: 'works as a backend engineer', createdAt: 1, updatedAt: 1 }
			]
		)!;
		expect(out).toContain("user's name is Chris");
		expect(out).toContain('Saved memories');
		expect(out).toContain('[m1] prefers metric units');
		expect(out).toContain('[m2] works as a backend engineer');
		// Persona section comes first.
		expect(out.indexOf('Chris')).toBeLessThan(out.indexOf('Saved memories'));
	});

	it('returns the memories section alone when prefs are empty but memories exist', () => {
		// A user with no preferences set but with saved memories should still
		// get a prompt — the memory section is independently sufficient.
		const out = composePersonaSystemPrompt(EMPTY_PREFS, [
			{ id: 'm1', content: 'prefers metric units', createdAt: 0, updatedAt: 0 }
		])!;
		expect(out).toContain('Saved memories');
		expect(out).toContain('[m1] prefers metric units');
		expect(out).not.toContain("user's name is");
	});
});
