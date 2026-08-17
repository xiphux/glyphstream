/**
 * Holds the line on the iOS launch-image block in `src/app.html` matching the
 * PNGs in `static/splash/`.
 *
 * iOS picks a launch image by EXACT match on device-width, device-height,
 * -webkit-device-pixel-ratio and orientation, and it does not scale or
 * nearest-fit. So the failure mode of a wrong href, a stale regeneration, or a
 * device row added without re-running `pnpm gen:splash` is not a mis-sized
 * splash — it is silently back to the blank white cold launch the whole block
 * exists to fix, on exactly one device, with everything still building,
 * type-checking and linting clean.
 *
 * The images are generated + committed, and the block is written by the
 * generator, so in the normal case this asserts a tautology. It is here for
 * the abnormal cases: someone hand-edits between the markers, or regenerates
 * the images without the HTML (or the reverse), or drops a file in a rebase.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const appHtml = readFileSync(
	fileURLToPath(new URL('../../src/app.html', import.meta.url)),
	'utf-8',
);
const splashDir = fileURLToPath(new URL('../../static/splash/', import.meta.url));

interface StartupImage {
	deviceWidth: number;
	deviceHeight: number;
	dpr: number;
	orientation: 'portrait' | 'landscape';
	scheme: 'light' | 'dark';
	href: string;
}

/**
 * Pull the declarations out of app.html. Prettier reflows each `<link>` across
 * four lines, so a line-anchored regex would quietly match nothing and turn
 * every assertion below into a vacuous pass over an empty array (hence the
 * non-empty check in the first test). Bounding on `[^>]` rather than a lazy
 * `[\s\S]*?` matters too: no attribute value here contains `>`, so `[^>]`
 * can't run past the end of a tag, whereas the lazy form starts at the
 * FIRST `<link` in the head (the favicon) and swallows the tags between.
 */
function parseStartupImages(): StartupImage[] {
	const tags = (appHtml.match(/<link[^>]*>/g) ?? []).filter((t) =>
		t.includes('apple-touch-startup-image'),
	);
	return tags.map((tag) => {
		const media = /media="([^"]+)"/.exec(tag)?.[1] ?? '';
		const href = /href="([^"]+)"/.exec(tag)?.[1] ?? '';
		const num = (prop: string): number => {
			const m = new RegExp(`\\(${prop}:\\s*([\\d.]+)`).exec(media);
			if (!m) throw new Error(`No ${prop} in media query: ${media}`);
			return Number(m[1]);
		};
		const word = <T extends string>(prop: string): T => {
			const m = new RegExp(`\\(${prop}:\\s*([a-z-]+)\\)`).exec(media);
			if (!m) throw new Error(`No ${prop} in media query: ${media}`);
			return m[1] as T;
		};
		return {
			deviceWidth: num('device-width'),
			deviceHeight: num('device-height'),
			dpr: num('-webkit-device-pixel-ratio'),
			orientation: word<'portrait' | 'landscape'>('orientation'),
			scheme: word<'light' | 'dark'>('prefers-color-scheme'),
			href,
		};
	});
}

/**
 * Width/height straight out of the PNG IHDR chunk — always the first chunk,
 * at a fixed offset after the 8-byte signature. Cheaper than pulling sharp
 * into a node-env unit test just to read two big-endian ints.
 */
function pngSize(path: string): { width: number; height: number } {
	const buf = readFileSync(path);
	expect(buf.subarray(1, 4).toString('ascii'), `${path} is not a PNG`).toBe('PNG');
	return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const images = parseStartupImages();

describe('iOS PWA launch images', () => {
	it('declares a startup image block at all', () => {
		// If this fails, iOS cold launches to white and nothing else notices.
		expect(images.length).toBeGreaterThan(0);
		expect(appHtml).toContain('<!-- splash:start -->');
		expect(appHtml).toContain('<!-- splash:end -->');
	});

	it('points every declaration at a PNG of exactly the device resolution', () => {
		const mismatched = images.filter((img) => {
			const expected =
				img.orientation === 'portrait'
					? { width: img.deviceWidth * img.dpr, height: img.deviceHeight * img.dpr }
					: { width: img.deviceHeight * img.dpr, height: img.deviceWidth * img.dpr };
			const actual = pngSize(`${splashDir}${img.href.replace('/splash/', '')}`);
			return actual.width !== expected.width || actual.height !== expected.height;
		});
		expect(mismatched.map((m) => m.href)).toEqual([]);
	});

	it('covers both orientations and both schemes for every declared device', () => {
		const byDevice = new Map<string, Set<string>>();
		for (const img of images) {
			const key = `${img.deviceWidth}x${img.deviceHeight}@${img.dpr}`;
			const seen = byDevice.get(key) ?? new Set<string>();
			seen.add(`${img.orientation}/${img.scheme}`);
			byDevice.set(key, seen);
		}
		const want = ['landscape/dark', 'landscape/light', 'portrait/dark', 'portrait/light'];
		for (const [device, seen] of byDevice) {
			expect([...seen].sort(), `incomplete coverage for ${device}`).toEqual(want);
		}
	});

	it('declares each device/orientation/scheme exactly once', () => {
		// A duplicate media query means the second declaration is dead — and
		// silently so, since iOS just takes a match and stops.
		const keys = images.map(
			(i) => `${i.deviceWidth}x${i.deviceHeight}@${i.dpr}/${i.orientation}/${i.scheme}`,
		);
		expect(keys.length).toBe(new Set(keys).size);
	});

	it('ships no unreferenced images', () => {
		// The generator wipes static/splash/ each run, so a leftover here means
		// the images and the HTML came from different runs.
		const referenced = new Set(images.map((i) => i.href.replace('/splash/', '')));
		// `.png` only: on macOS a stray .DS_Store would otherwise fail this with
		// something that has nothing to do with the invariant being asserted.
		const orphans = readdirSync(splashDir).filter((f) => f.endsWith('.png') && !referenced.has(f));
		expect(orphans).toEqual([]);
	});
});
