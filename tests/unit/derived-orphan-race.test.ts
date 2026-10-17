/**
 * A hard delete that lands while a derived file is being generated must not
 * leave that file behind. Real sharp, real files; the only filesystem seam is
 * `rename`, which runs the delete first when armed — the moment after the encode
 * has its bytes and before the derived file exists for `DiskMediaStore.delete`
 * to find.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { photoPng } from './_helpers/photo-png';

const state = vi.hoisted(() => ({
	root: '',
	beforeRename: null as null | (() => Promise<void>),
}));

vi.mock('#lib/server/env.js', () => ({
	mediaDir: () => state.root,
	derivedDir: () => state.root,
	dbPath: () => './data/glyphstream.db',
	configPath: () => './config.toml',
}));
vi.mock('#lib/server/endpoints/config.js', () => ({
	getVisionConfig: () => ({ maxImageDim: 1568, imageQuality: 82 }),
}));
vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>();
	return {
		...actual,
		rename: async (from: string, to: string) => {
			const hook = state.beforeRename;
			state.beforeRename = null;
			if (hook) await hook();
			return actual.rename(from, to);
		},
	};
});

import { DiskMediaStore } from '#lib/server/media/disk-store.js';
import { getOrCreateThumbnail, thumbStoragePath } from '#lib/server/media/thumbnail.js';
import { getVisionVariant, visionStoragePath } from '#lib/server/media/vision-variant.js';
import {
	displayStoragePath,
	getOrCreateDisplayVariant,
} from '#lib/server/media/display-variant.js';

const STORAGE_PATH = 'ab/cd/photo.png';

async function writeOriginal(): Promise<void> {
	const abs = resolve(state.root, STORAGE_PATH);
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, await photoPng(3000, 2000));
}

function deleteDuringEncode(): void {
	state.beforeRename = () => new DiskMediaStore().delete(STORAGE_PATH);
}

beforeEach(async () => {
	state.root = mkdtempSync(join(tmpdir(), 'gs-derived-orphan-'));
	await writeOriginal();
});
afterEach(() => {
	state.beforeRename = null;
	rmSync(state.root, { recursive: true, force: true });
});

describe('a delete landing mid-generation', () => {
	it.each([
		['thumbnail', () => getOrCreateThumbnail(STORAGE_PATH, 'image'), thumbStoragePath],
		['vision variant', () => getVisionVariant(STORAGE_PATH), visionStoragePath],
		['display variant', () => getOrCreateDisplayVariant(STORAGE_PATH), displayStoragePath],
	] as const)('leaves no %s behind', async (_name, generate, derivedPath) => {
		deleteDuringEncode();
		expect(await generate()).toBeNull();
		expect(state.beforeRename).toBeNull(); // the delete really ran
		expect(existsSync(resolve(state.root, STORAGE_PATH))).toBe(false);
		expect(existsSync(resolve(state.root, derivedPath(STORAGE_PATH)))).toBe(false);
		// Nothing else either: no temp file, nothing beside where the original was.
		expect(readdirSync(resolve(state.root, 'ab/cd'))).toEqual([]);
	});

	it('keeps the thumbnail when the original is still there', async () => {
		const thumb = await getOrCreateThumbnail(STORAGE_PATH, 'image');
		expect(thumb).not.toBeNull();
		expect(existsSync(resolve(state.root, thumbStoragePath(STORAGE_PATH)))).toBe(true);
	});
});
