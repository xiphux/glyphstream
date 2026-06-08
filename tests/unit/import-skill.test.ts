import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB }));
vi.mock('$lib/server/db/client', () => ({
	getDb: () => mocks.testDb,
	closeDb: () => {},
}));
vi.mock('$lib/server/env', async () => {
	const { mkdtempSync } = await import('node:fs');
	const { tmpdir } = await import('node:os');
	const { join } = await import('node:path');
	const dir = mkdtempSync(join(tmpdir(), 'gs-import-test-'));
	return { skillsDir: () => dir };
});

import { skillsDir } from '$lib/server/env';
import { importSkillBundle, normalizeBundleFiles } from '$lib/server/skills/import-skill';
import { getSkillStore } from '$lib/server/skills/disk-store';
import { listSkillsForUser } from '$lib/server/db/queries/skills';

beforeEach(() => {
	mocks.testDb = createTestDb();
});
afterEach(() => closeTestDb());
afterAll(async () => {
	const { rm } = await import('node:fs/promises');
	await rm(skillsDir(), { recursive: true, force: true }).catch(() => {});
});

function f(relPath: string, body: string) {
	return { relPath, bytes: Buffer.from(body, 'utf8') };
}

const VALID_SKILL = `---\nname: my-skill\ndescription: A test skill.\n---\n\n# My Skill\n\nDo the thing.`;

describe('normalizeBundleFiles', () => {
	it('strips a single shared top-level directory (folder upload)', () => {
		const r = normalizeBundleFiles([
			f('my-skill/SKILL.md', 'a'),
			f('my-skill/references/api.md', 'b'),
		]);
		expect(r.ok && r.files.map((x) => x.relPath)).toEqual(['SKILL.md', 'references/api.md']);
	});

	it('leaves loose root files untouched', () => {
		const r = normalizeBundleFiles([f('SKILL.md', 'a')]);
		expect(r.ok && r.files.map((x) => x.relPath)).toEqual(['SKILL.md']);
	});

	it('rejects a traversal path', () => {
		expect(normalizeBundleFiles([f('../evil.md', 'x')])).toMatchObject({ ok: false });
	});

	it('does not strip when files have differing top-level dirs', () => {
		const r = normalizeBundleFiles([f('a/SKILL.md', 'x'), f('b/other.md', 'y')]);
		expect(r.ok && r.files.map((x) => x.relPath).sort()).toEqual(['a/SKILL.md', 'b/other.md']);
	});
});

describe('importSkillBundle', () => {
	it('imports a pasted SKILL.md: writes the row and the bundle', async () => {
		const u = seedUser();
		const res = await importSkillBundle(u.id, [f('SKILL.md', VALID_SKILL)]);
		expect(res.ok).toBe(true);
		const list = listSkillsForUser(u.id);
		expect(list).toHaveLength(1);
		expect(list[0].name).toBe('my-skill');
		expect(list[0].description).toBe('A test skill.');
		// Body persisted to disk with frontmatter intact.
		const onDisk = await getSkillStore().readSkillMd(`${u.id}/my-skill`);
		expect(onDisk).toContain('Do the thing.');
	});

	it('imports a multi-file folder bundle after stripping the top dir', async () => {
		const u = seedUser();
		const res = await importSkillBundle(u.id, [
			f('my-skill/SKILL.md', VALID_SKILL),
			f('my-skill/references/api.md', '# API'),
		]);
		expect(res.ok).toBe(true);
		expect(await getSkillStore().readFile(`${u.id}/my-skill`, 'references/api.md')).not.toBeNull();
	});

	it('rejects a duplicate name with 409 and leaves the original bundle intact', async () => {
		const u = seedUser();
		await importSkillBundle(u.id, [f('SKILL.md', VALID_SKILL)]);
		const dup = await importSkillBundle(u.id, [
			f('SKILL.md', `---\nname: my-skill\ndescription: different.\n---\nNEW BODY`),
		]);
		expect(dup).toMatchObject({ ok: false, status: 409 });
		// Original bundle must NOT have been overwritten by the rejected import.
		const onDisk = await getSkillStore().readSkillMd(`${u.id}/my-skill`);
		expect(onDisk).toContain('Do the thing.');
		expect(onDisk).not.toContain('NEW BODY');
	});

	it('rejects a bundle with no SKILL.md (400)', async () => {
		const u = seedUser();
		const res = await importSkillBundle(u.id, [f('readme.md', 'nope')]);
		expect(res).toMatchObject({ ok: false, status: 400 });
	});

	it('rejects an invalid SKILL.md (400)', async () => {
		const u = seedUser();
		const res = await importSkillBundle(u.id, [f('SKILL.md', '---\nname: Bad Name\n---\nx')]);
		expect(res).toMatchObject({ ok: false, status: 400 });
	});
});
