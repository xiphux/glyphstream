/**
 * DERIVED_DIR — where lazily-derived assets land when they don't live beside
 * their originals.
 *
 * The split exists because thumbnails and vision variants have the opposite
 * storage profile to the originals they come from: ~1/70th the size, read far
 * more often than written (a gallery grid is 30-60 at once; a vision variant is
 * re-read on every turn of a conversation), and regenerable, so losing one costs
 * a re-encode rather than data. That makes them the wrong thing to put on the
 * big slow volume MEDIA_DIR may point at, and the right thing to keep local.
 *
 * These tests drive the REAL env module (mocking `$env/dynamic/private` rather
 * than `$lib/server/env`) against real temp directories, because the wiring is
 * the whole feature — a module that resolved the wrong root would still pass
 * every test that mocks `derivedDir()` alongside `mediaDir()`.
 *
 * Two properties carry the weight:
 *
 *   - Derived assets go under DERIVED_DIR and the original never moves. The
 *     failure this catches is silent and expensive: writing thumbs to the
 *     network volume anyway leaves the gallery exactly as slow as before, with
 *     nothing to show that the setting did nothing.
 *   - `delete()` reaps them from DERIVED_DIR. Resolving that against the media
 *     root instead leaks both derivatives per hard-deleted image, forever, on a
 *     volume nothing else sweeps.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Buffer } from 'node:buffer';
import { photoPng } from './_helpers/photo-png';

const e = vi.hoisted(() => ({ vars: {} as Record<string, string | undefined> }));
vi.mock('$env/dynamic/private', () => ({ env: e.vars }));
vi.mock('$lib/server/endpoints/config', () => ({
	getVisionConfig: () => ({ maxImageDim: 1568, imageQuality: 82 }),
}));

const { derivedDir, mediaDir } = await import('$lib/server/env');
const { getOrCreateThumbnail, thumbStoragePath } = await import('$lib/server/media/thumbnail');
const { getVisionVariant, visionStoragePath } = await import('$lib/server/media/vision-variant');
const { DiskMediaStore } = await import('$lib/server/media/disk-store');

const STORAGE_PATH = 'ab/cd/original.png';

let media = '';
let derived = '';

/** Write an original under MEDIA_DIR, creating its shard. */
function writeOriginal(bytes: Buffer, storagePath: string = STORAGE_PATH): void {
	const abs = resolve(media, storagePath);
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, bytes);
}

beforeEach(() => {
	media = mkdtempSync(join(tmpdir(), 'gs-media-'));
	derived = mkdtempSync(join(tmpdir(), 'gs-derived-'));
	// MUTATE the object rather than reassigning it: the mock factory runs once
	// and captured this exact reference, so `e.vars = {...}` would swap in an
	// object the module under test never sees — leaving every read on the
	// defaults, where MEDIA_DIR and DERIVED_DIR happen to agree and the
	// assertions pass without testing anything.
	for (const k of Object.keys(e.vars)) delete e.vars[k];
	e.vars.MEDIA_DIR = media;
	e.vars.DERIVED_DIR = derived;
});

afterEach(() => {
	rmSync(media, { recursive: true, force: true });
	rmSync(derived, { recursive: true, force: true });
});

describe('derivedDir()', () => {
	it('falls back to MEDIA_DIR when unset, so existing installs do not move', () => {
		delete e.vars.DERIVED_DIR;
		expect(derivedDir()).toBe(media);
		expect(derivedDir()).toBe(mediaDir());
	});

	it('is used verbatim when set', () => {
		expect(derivedDir()).toBe(derived);
	});
});

describe('derived assets under a separate root', () => {
	it('writes the thumbnail to DERIVED_DIR and leaves the original where it is', async () => {
		const original = await photoPng(1400, 900);
		writeOriginal(original);

		const thumb = await getOrCreateThumbnail(STORAGE_PATH);
		expect(thumb).not.toBeNull();
		expect(thumb!.absolutePath).toBe(resolve(derived, thumbStoragePath(STORAGE_PATH)));
		expect(existsSync(thumb!.absolutePath)).toBe(true);

		// Nothing derived was left on the media volume, and the original is
		// untouched — the two halves of "MEDIA_DIR stays cold".
		expect(existsSync(resolve(media, thumbStoragePath(STORAGE_PATH)))).toBe(false);
		expect(existsSync(resolve(media, STORAGE_PATH))).toBe(true);
	});

	it('writes the vision variant to DERIVED_DIR', async () => {
		writeOriginal(await photoPng(2400, 1600));

		const variant = await getVisionVariant(STORAGE_PATH);
		expect(variant).not.toBeNull();
		expect(existsSync(resolve(derived, visionStoragePath(STORAGE_PATH)))).toBe(true);
		expect(existsSync(resolve(media, visionStoragePath(STORAGE_PATH)))).toBe(false);
	});

	it('keeps the relative path identical under either root', async () => {
		// This is what makes migrating an existing install a file move rather than
		// a re-derive, and what the documented `cpio` one-liner relies on. A change
		// that flattened or re-sharded the derived tree would still serve correct
		// thumbnails and would silently invalidate that advice.
		writeOriginal(await photoPng(1400, 900));
		await getOrCreateThumbnail(STORAGE_PATH);
		await getVisionVariant(STORAGE_PATH);

		for (const rel of [thumbStoragePath(STORAGE_PATH), visionStoragePath(STORAGE_PATH)]) {
			expect(rel.startsWith('ab/cd/')).toBe(true);
			expect(existsSync(resolve(derived, rel))).toBe(true);
		}
	});
});

describe('an unusable DERIVED_DIR degrades instead of failing the request', () => {
	// Once the derived root is separately configurable it can be absent, read-only,
	// or unmounted while MEDIA_DIR is perfectly healthy — a state that was not
	// reachable when the two were the same directory, because the original had to
	// be readable out of it for either generator to run at all.
	//
	// Simulated with a path whose PARENT is a regular file, which makes mkdir fail
	// with ENOTDIR everywhere without needing permissions games or root. What is
	// being pinned is the shape of the failure, not the errno: both generators owe
	// their callers a null (the documented "fall back to the original" signal) and
	// must not throw, because both are reached from a request — the gallery tile
	// endpoint and the per-turn send path.
	// Its OWN storage path, not the shared one. `getVisionVariant` short-circuits
	// on the module-level `declined` set before it touches the filesystem, and that
	// set outlives every test in this file — so a future test here that declined
	// the shared path would make both assertions below pass without reaching the
	// mkdir they exist to exercise, silently. Nothing declines it today; this just
	// removes the coupling rather than relying on that staying true.
	const DEGRADES_PATH = 'ef/01/degrades.png';

	beforeEach(() => {
		const blocker = join(media, 'not-a-directory');
		writeFileSync(blocker, 'this is a file, so nothing can be mkdir-ed beneath it');
		e.vars.DERIVED_DIR = join(blocker, 'derived');
		vi.spyOn(console, 'warn').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('returns null from getOrCreateThumbnail rather than 500ing the tile', async () => {
		writeOriginal(await photoPng(1400, 900), DEGRADES_PATH);
		await expect(getOrCreateThumbnail(DEGRADES_PATH)).resolves.toBeNull();
	});

	it('returns null from getVisionVariant rather than failing the send', async () => {
		writeOriginal(await photoPng(2400, 1600), DEGRADES_PATH);
		await expect(getVisionVariant(DEGRADES_PATH)).resolves.toBeNull();
	});
});

describe('DiskMediaStore.delete with a separate derived root', () => {
	it('reaps the thumbnail and the vision variant from DERIVED_DIR', async () => {
		writeOriginal(await photoPng(2400, 1600));
		await getOrCreateThumbnail(STORAGE_PATH);
		await getVisionVariant(STORAGE_PATH);

		const thumbAbs = resolve(derived, thumbStoragePath(STORAGE_PATH));
		const variantAbs = resolve(derived, visionStoragePath(STORAGE_PATH));
		expect(existsSync(thumbAbs)).toBe(true);
		expect(existsSync(variantAbs)).toBe(true);

		await new DiskMediaStore().delete(STORAGE_PATH);

		expect(existsSync(resolve(media, STORAGE_PATH))).toBe(false);
		expect(existsSync(thumbAbs)).toBe(false);
		expect(existsSync(variantAbs)).toBe(false);
	});
});
