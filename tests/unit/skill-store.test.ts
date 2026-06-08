import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';

// Point the store's SKILLS_DIR at a throwaway temp dir for this file. The
// factory is async so it can create the dir without a hoisting dance.
vi.mock('$lib/server/env', async () => {
	const { mkdtempSync } = await import('node:fs');
	const { tmpdir } = await import('node:os');
	const { join } = await import('node:path');
	const dir = mkdtempSync(join(tmpdir(), 'gs-skills-test-'));
	return { skillsDir: () => dir };
});

import { skillsDir } from '$lib/server/env';
import { DiskSkillStore, safeJoin, getSkillStore } from '$lib/server/skills/disk-store';
import { MAX_BUNDLE_FILES } from '$lib/server/skills/store';

afterAll(async () => {
	const { rm } = await import('node:fs/promises');
	await rm(skillsDir(), { recursive: true, force: true }).catch(() => {});
});

function file(relPath: string, body: string) {
	return { relPath, bytes: Buffer.from(body, 'utf8') };
}

describe('safeJoin', () => {
	const base = resolve('/tmp/jail');

	it('resolves a simple relative path', () => {
		expect(safeJoin(base, 'SKILL.md')).toBe(resolve(base, 'SKILL.md'));
		expect(safeJoin(base, 'references/api.md')).toBe(resolve(base, 'references/api.md'));
	});

	it('rejects parent-traversal', () => {
		expect(safeJoin(base, '..')).toBeNull();
		expect(safeJoin(base, '../secret')).toBeNull();
		expect(safeJoin(base, 'a/../../secret')).toBeNull();
	});

	it('rejects absolute paths and NUL bytes', () => {
		expect(safeJoin(base, '/etc/passwd')).toBeNull();
		expect(safeJoin(base, 'a\0b')).toBeNull();
	});

	it('rejects Windows-style backslash traversal', () => {
		expect(safeJoin(base, '..\\secret')).toBeNull();
	});

	it('rejects the empty/self path', () => {
		expect(safeJoin(base, '')).toBeNull();
		expect(safeJoin(base, '.')).toBeNull();
	});
});

describe('DiskSkillStore', () => {
	let store: DiskSkillStore;
	const sp = 'user-1/my-skill';

	beforeEach(() => {
		store = new DiskSkillStore();
	});

	it('round-trips a bundle: putBundle, readSkillMd, readFile, listFiles', async () => {
		await store.putBundle(sp, [
			file('SKILL.md', '---\nname: my-skill\ndescription: d\n---\nbody'),
			file('references/api.md', '# API'),
			file('scripts/run.py', 'print(1)'),
		]);

		expect(await store.readSkillMd(sp)).toContain('name: my-skill');
		const apiFile = await store.readFile(sp, 'references/api.md');
		expect(apiFile?.bytes.toString('utf8')).toBe('# API');
		expect(apiFile?.relPath).toBe('references/api.md');

		const listed = await store.listFiles(sp);
		expect(listed).toEqual(['SKILL.md', 'references/api.md', 'scripts/run.py']);
	});

	it('returns null reading an absent bundle / file', async () => {
		expect(await store.readSkillMd('user-1/ghost')).toBeNull();
		await store.putBundle(sp, [file('SKILL.md', 'x')]);
		expect(await store.readFile(sp, 'nope.txt')).toBeNull();
	});

	it('jails readFile against traversal escapes', async () => {
		await store.putBundle(sp, [file('SKILL.md', 'x')]);
		await expect(store.readFile(sp, '../../etc/passwd')).rejects.toThrow();
		await expect(store.readFile(sp, '/etc/passwd')).rejects.toThrow();
	});

	it('replaces an existing bundle atomically (no stale files linger)', async () => {
		await store.putBundle(sp, [file('SKILL.md', 'v1'), file('old.md', 'gone')]);
		await store.putBundle(sp, [file('SKILL.md', 'v2')]);
		expect(await store.readSkillMd(sp)).toBe('v2');
		expect(await store.readFile(sp, 'old.md')).toBeNull();
	});

	it('rejects an unsafe path inside a bundle', async () => {
		await expect(store.putBundle(sp, [file('../escape.md', 'x')])).rejects.toThrow();
	});

	it('enforces the file-count cap', async () => {
		const many = Array.from({ length: MAX_BUNDLE_FILES + 1 }, (_, i) => file(`f${i}.md`, 'x'));
		await expect(store.putBundle(sp, many)).rejects.toThrow();
	});

	it('deleteBundle removes the directory', async () => {
		await store.putBundle(sp, [file('SKILL.md', 'x')]);
		await store.deleteBundle(sp);
		expect(await store.readSkillMd(sp)).toBeNull();
	});

	it('moveBundle relocates a bundle (rename support)', async () => {
		await store.putBundle('user-1/old-name', [file('SKILL.md', 'x')]);
		await store.moveBundle('user-1/old-name', 'user-1/new-name');
		expect(await store.readSkillMd('user-1/old-name')).toBeNull();
		expect(await store.readSkillMd('user-1/new-name')).toBe('x');
	});

	it('getSkillStore returns a singleton', () => {
		expect(getSkillStore()).toBe(getSkillStore());
	});
});
