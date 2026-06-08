import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB }));
vi.mock('$lib/server/db/client', () => ({
	getDb: () => mocks.testDb,
	closeDb: () => {},
}));

import {
	composeSkillsCatalog,
	createSkill,
	deleteSkill,
	getEnabledSkillByName,
	listEnabledSkillsForUser,
	listSkillsForUser,
	setSkillEnabled,
	skillExistsByName,
	skillStoragePath,
} from '$lib/server/db/queries/skills';
import { users } from '$lib/server/db/schema';

beforeEach(() => {
	mocks.testDb = createTestDb();
});

afterEach(() => {
	closeTestDb();
});

function makeSkill(userId: string, name: string, description = `desc for ${name}`) {
	return createSkill({ userId, name, description, storagePath: skillStoragePath(userId, name) });
}

describe('createSkill + listSkillsForUser', () => {
	it('returns an empty array for a user with no skills', () => {
		const u = seedUser();
		expect(listSkillsForUser(u.id)).toEqual([]);
	});

	it('creates an enabled skill and lists it', () => {
		const u = seedUser();
		const s = makeSkill(u.id, 'pdf-processing');
		const list = listSkillsForUser(u.id);
		expect(list).toHaveLength(1);
		expect(list[0].name).toBe('pdf-processing');
		expect(list[0].enabled).toBe(true);
		expect(s.enabled).toBe(true);
	});

	it('throws on a duplicate (userId, name)', () => {
		const u = seedUser();
		makeSkill(u.id, 'dup');
		expect(() => makeSkill(u.id, 'dup')).toThrow();
	});

	it('allows the same name for different users', () => {
		const u1 = seedUser();
		const u2 = seedUser();
		makeSkill(u1.id, 'shared');
		expect(() => makeSkill(u2.id, 'shared')).not.toThrow();
	});

	it('scopes by user', () => {
		const u1 = seedUser();
		const u2 = seedUser();
		makeSkill(u1.id, 'mine');
		makeSkill(u2.id, 'theirs');
		expect(listSkillsForUser(u1.id).map((s) => s.name)).toEqual(['mine']);
	});
});

describe('skillExistsByName', () => {
	it('reflects presence regardless of enabled state', () => {
		const u = seedUser();
		const s = makeSkill(u.id, 'x');
		expect(skillExistsByName(u.id, 'x')).toBe(true);
		setSkillEnabled(u.id, s.id, false);
		expect(skillExistsByName(u.id, 'x')).toBe(true);
		expect(skillExistsByName(u.id, 'nope')).toBe(false);
	});
});

describe('listEnabledSkillsForUser + getEnabledSkillByName', () => {
	it('excludes disabled skills', () => {
		const u = seedUser();
		const a = makeSkill(u.id, 'enabled-skill');
		const b = makeSkill(u.id, 'disabled-skill');
		setSkillEnabled(u.id, b.id, false);
		const enabled = listEnabledSkillsForUser(u.id);
		expect(enabled.map((s) => s.name)).toEqual(['enabled-skill']);
		expect(getEnabledSkillByName(u.id, 'enabled-skill')?.id).toBe(a.id);
		expect(getEnabledSkillByName(u.id, 'disabled-skill')).toBeNull();
	});

	it('returns the storagePath for activation', () => {
		const u = seedUser();
		makeSkill(u.id, 'x');
		expect(getEnabledSkillByName(u.id, 'x')?.storagePath).toBe(`${u.id}/x`);
	});

	it('does not resolve a foreign user’s skill by name', () => {
		const u1 = seedUser();
		const u2 = seedUser();
		makeSkill(u1.id, 'secret');
		expect(getEnabledSkillByName(u2.id, 'secret')).toBeNull();
	});
});

describe('setSkillEnabled', () => {
	it('toggles and returns true', () => {
		const u = seedUser();
		const s = makeSkill(u.id, 'x');
		expect(setSkillEnabled(u.id, s.id, false)).toBe(true);
		expect(listSkillsForUser(u.id)[0].enabled).toBe(false);
		expect(setSkillEnabled(u.id, s.id, true)).toBe(true);
		expect(listSkillsForUser(u.id)[0].enabled).toBe(true);
	});

	it('returns false for a foreign user’s id', () => {
		const u1 = seedUser();
		const u2 = seedUser();
		const s = makeSkill(u1.id, 'x');
		expect(setSkillEnabled(u2.id, s.id, false)).toBe(false);
		expect(listSkillsForUser(u1.id)[0].enabled).toBe(true);
	});
});

describe('deleteSkill', () => {
	it('removes the row and returns the storagePath for bundle cleanup', () => {
		const u = seedUser();
		const s = makeSkill(u.id, 'x');
		const deleted = deleteSkill(u.id, s.id);
		expect(deleted?.storagePath).toBe(`${u.id}/x`);
		expect(listSkillsForUser(u.id)).toEqual([]);
	});

	it('returns null for a foreign user’s id and leaves the row', () => {
		const u1 = seedUser();
		const u2 = seedUser();
		const s = makeSkill(u1.id, 'x');
		expect(deleteSkill(u2.id, s.id)).toBeNull();
		expect(listSkillsForUser(u1.id)).toHaveLength(1);
	});

	it('cascade-deletes when the user is deleted', () => {
		const u = seedUser();
		makeSkill(u.id, 'x');
		mocks.testDb.delete(users).where(eq(users.id, u.id)).run();
		expect(listSkillsForUser(u.id)).toEqual([]);
	});
});

describe('composeSkillsCatalog', () => {
	it('returns null for an empty list', () => {
		expect(composeSkillsCatalog([])).toBeNull();
	});

	it('wraps the catalog and lists each skill as `name — description`', () => {
		const out = composeSkillsCatalog([
			{ name: 'pdf-processing', description: 'Handle PDFs.' },
			{ name: 'data-analysis', description: 'Analyze datasets.' },
		])!;
		expect(out).toContain('<available_skills>');
		expect(out).toContain('</available_skills>');
		expect(out).toContain('- pdf-processing — Handle PDFs.');
		expect(out).toContain('- data-analysis — Analyze datasets.');
		// Header must teach the model the activation contract.
		expect(out).toMatch(/activate_skill/);
	});
});
