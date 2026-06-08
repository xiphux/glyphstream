import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB }));
vi.mock('$lib/server/db/client', () => ({
	getDb: () => mocks.testDb,
	closeDb: () => {},
}));

import { createSkill, setSkillEnabled, skillStoragePath } from '$lib/server/db/queries/skills';
import { appendSkillsCatalog, buildSkillsRequestContext } from '$lib/server/chat/skills-context';

beforeEach(() => {
	mocks.testDb = createTestDb();
});
afterEach(() => closeTestDb());

function makeSkill(userId: string, name: string) {
	return createSkill({
		userId,
		name,
		description: `desc ${name}`,
		storagePath: skillStoragePath(userId, name),
	});
}

describe('buildSkillsRequestContext', () => {
	it('returns the empty context when the skills category is disabled', () => {
		const u = seedUser();
		makeSkill(u.id, 'x');
		const ctx = buildSkillsRequestContext(u.id, ['skills']);
		expect(ctx.catalog).toBeNull();
		expect(ctx.toolDefs).toEqual([]);
	});

	it('returns the empty context when the user has no enabled skills', () => {
		const u = seedUser();
		const s = makeSkill(u.id, 'x');
		setSkillEnabled(u.id, s.id, false);
		const ctx = buildSkillsRequestContext(u.id, []);
		expect(ctx.catalog).toBeNull();
		expect(ctx.toolDefs).toEqual([]);
	});

	it('builds a catalog + both tools when enabled skills exist', () => {
		const u = seedUser();
		makeSkill(u.id, 'pdf-processing');
		const ctx = buildSkillsRequestContext(u.id, []);
		expect(ctx.catalog).toContain('pdf-processing');
		expect(ctx.toolDefs.map((d) => d.function.name)).toEqual(['activate_skill', 'read_skill_file']);
		// The enum must reflect the user's enabled skill names.
		const props = ctx.toolDefs[0].function.parameters.properties as Record<
			string,
			{ enum?: string[] }
		>;
		expect(props.name.enum).toEqual(['pdf-processing']);
	});
});

describe('appendSkillsCatalog', () => {
	it('joins a base prompt and catalog with a blank line', () => {
		expect(appendSkillsCatalog('BASE', 'CATALOG')).toBe('BASE\n\nCATALOG');
	});

	it('passes through when one side is null', () => {
		expect(appendSkillsCatalog(null, 'CATALOG')).toBe('CATALOG');
		expect(appendSkillsCatalog('BASE', null)).toBe('BASE');
	});

	it('returns null when both are absent', () => {
		expect(appendSkillsCatalog(null, null)).toBeNull();
	});
});
