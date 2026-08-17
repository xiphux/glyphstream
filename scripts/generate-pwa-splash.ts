/**
 * Generates the iOS PWA launch images (`static/splash/`) and rewrites the
 * `apple-touch-startup-image` link block in `src/app.html`.
 *
 * Run with `pnpm gen:splash` after changing the mark in `static/icon.svg`,
 * the surface colours below, or the device table. The output is committed —
 * this is not part of `pnpm build`, for the same reason `apple-touch-icon.png`
 * isn't: the inputs change about once a year.
 *
 * WHY THIS EXISTS AT ALL. Chrome/Android synthesises a launch screen from the
 * manifest's `background_color` + a >=512px icon. iOS does not, and never has:
 * a home-screen web app with no matching `apple-touch-startup-image` launches
 * to a blank white screen and holds it until first paint. On a cold launch
 * right after a server update — new SSR HTML from a cold Node process, plus a
 * full re-download of the rehashed `_app/immutable` graph — that's multiple
 * seconds of white. The images below are what iOS shows instead.
 *
 * iOS picks an image by EXACT match on the media query: device-width,
 * device-height, -webkit-device-pixel-ratio and orientation all have to line
 * up with the hardware. There is no scaling and no nearest-fit — a device
 * absent from the table below simply gets the old white screen back, which is
 * why the table is exhaustive rather than "the popular ones".
 */
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { format, resolveConfig } from 'prettier';
import sharp from 'sharp';

/** A distinct (logical size x scale) the hardware comes in. */
interface Device {
	/** Logical CSS width in portrait, i.e. what `device-width` reports. */
	readonly w: number;
	/** Logical CSS height in portrait. */
	readonly h: number;
	/** Scale factor, i.e. what `-webkit-device-pixel-ratio` reports. */
	readonly dpr: number;
	/** Models sharing this geometry. Comment only — nothing keys off it. */
	readonly models: string;
}

/**
 * Every distinct iPhone/iPad geometry, deduped — a size is listed once no
 * matter how many models share it. Portrait orientation; landscape is derived.
 *
 * Sourced from ios-resolution.com. When Apple ships a new size, add a row and
 * re-run; models that reuse an existing panel (most of them) need nothing.
 */
const DEVICES: readonly Device[] = [
	// --- iPhone ---
	{ w: 320, h: 568, dpr: 2, models: 'SE (1st gen), 5/5s/5c' },
	{ w: 375, h: 667, dpr: 2, models: '6/6s/7/8, SE (2nd/3rd gen)' },
	{ w: 414, h: 736, dpr: 3, models: '6+/6s+/7+/8+' },
	{ w: 375, h: 812, dpr: 3, models: 'X, XS, 11 Pro, 12 mini, 13 mini' },
	{ w: 414, h: 896, dpr: 2, models: 'XR, 11' },
	{ w: 414, h: 896, dpr: 3, models: 'XS Max, 11 Pro Max' },
	{ w: 390, h: 844, dpr: 3, models: '12, 12 Pro, 13, 13 Pro, 14, 16e, 17e' },
	{ w: 428, h: 926, dpr: 3, models: '12 Pro Max, 13 Pro Max, 14 Plus' },
	{ w: 393, h: 852, dpr: 3, models: '14 Pro, 15, 15 Pro, 16' },
	{ w: 430, h: 932, dpr: 3, models: '14 Pro Max, 15 Plus, 15 Pro Max, 16 Plus' },
	{ w: 402, h: 874, dpr: 3, models: '16 Pro, 17, 17 Pro' },
	{ w: 440, h: 956, dpr: 3, models: '16 Pro Max, 17 Pro Max' },
	{ w: 420, h: 912, dpr: 3, models: 'Air' },
	// --- iPad ---
	{ w: 768, h: 1024, dpr: 2, models: 'iPad 9.7", mini 1-5, Air 1/2' },
	{ w: 810, h: 1080, dpr: 2, models: 'iPad 7th/8th/9th gen (10.2")' },
	{ w: 820, h: 1180, dpr: 2, models: 'iPad 10th/11th gen, Air 11" (M2/M3)' },
	{ w: 744, h: 1133, dpr: 2, models: 'iPad mini 6th/7th gen' },
	{ w: 834, h: 1112, dpr: 2, models: 'iPad Pro 10.5", Air 3rd gen' },
	{ w: 834, h: 1194, dpr: 2, models: 'iPad Pro 11" (gen 1-4), Air 4th/5th gen' },
	{ w: 834, h: 1210, dpr: 2, models: 'iPad Pro 11" (M4/M5)' },
	{ w: 1024, h: 1366, dpr: 2, models: 'iPad Pro 12.9" (all), Air 13" (M2/M3)' },
	{ w: 1032, h: 1376, dpr: 2, models: 'iPad Pro 13" (M4/M5)' },
];

/**
 * Launch surfaces, keyed by the `prefers-color-scheme` they answer to.
 *
 * These are the sRGB of the DEFAULT (Signature) theme's `--color-surface` in
 * each scheme, hand-converted from the oklch in app.css — `oklch(15% 0.012 258)`
 * dark, `oklch(98.5% 0.006 250)` light. That token is what `body` paints and
 * therefore what the launch image has to hand off to.
 *
 * Do NOT substitute the brand navy `#0f172a` here, however tempting the match
 * with icon.svg's tile. (The manifest's background_color used to be that navy
 * too and was moved to `#080b10` alongside this — Chrome synthesises its
 * launch screen from it, so it is the Android counterpart of these images, not
 * a reason to change them back.) The navy is Tailwind slate-900 — chroma 0.04
 * at hue 266, nowhere on the Signature ramp — and it sat here through a
 * release: against the real `#080b10` surface it measures ΔE2000 9.5, where
 * the deliberate surface-to-sidebar step measures 2.2, and the difference is
 * mostly lightness, the most visible kind. It flashed on exactly the cold
 * launch this file exists to smooth. `tests/unit/pwa-splash-colors.test.ts`
 * re-derives both values from app.css and now holds the line.
 *
 * Two mismatches remain unavoidable, and both do cost a flash:
 *
 * - Scheme: iOS matches the *OS* setting, so someone who has forced light or
 *   dark in-app via the gs-scheme cookie against their OS gets the OS one.
 *   There is no cookie-aware form of this media query.
 * - Theme: `--color-surface` varies by `[data-theme]` too, and the Claude and
 *   ChatGPT palettes are nowhere near this blue-slate. `apple-touch-startup-image`
 *   can only be selected by media query, and there is no theme media query, so
 *   a non-Signature user launches into Signature colours regardless.
 */
const SCHEMES = [
	{ name: 'dark', bg: '#080b10' },
	{ name: 'light', bg: '#f7fafe' },
] as const;

/**
 * Mark size as a fraction of the image's SHORTER edge, so the same geometry
 * reads at the same relative scale in both orientations and on both form
 * factors. Roughly matches how large a native app's launch-screen icon sits.
 */
const MARK_FRACTION = 0.28;
/** Never let the iPad marks balloon; a launch icon is small by convention. */
const MARK_MAX_PX = 420;

const root = new URL('../', import.meta.url);
const outDir = new URL('static/splash/', root);
/** Staged renders; renamed over `outDir` only after the last one succeeds.
 *  Sibling of the target so the rename stays within one filesystem. */
const stagingDir = new URL('static/.splash-staging/', root);
const appHtmlPath = fileURLToPath(new URL('src/app.html', root));
const iconPath = fileURLToPath(new URL('static/icon.svg', root));

const START_MARKER = '<!-- splash:start -->';
const END_MARKER = '<!-- splash:end -->';

/**
 * The mark on its own, transparent — `icon.svg` is the rounded-tile form and
 * paints its own slate background, which would show as a square patch on the
 * light splash. Stripping the rect keeps `icon.svg` the single source of truth
 * for the geometry rather than forking a second copy of the path data.
 */
async function loadMark(): Promise<string> {
	const svg = await readFile(iconPath, 'utf-8');
	const stripped = svg.replace(/\s*<rect\b[^>]*\/>/, '');
	if (stripped === svg) {
		throw new Error(
			`No background <rect> found in ${iconPath} — the icon changed shape. ` +
				`Update loadMark() so the splash mark stays transparent.`,
		);
	}
	return stripped;
}

/** `splash/<w>x<h>-<scheme>.png`, in device pixels. */
function fileName(px: number, py: number, scheme: string): string {
	return `${px}x${py}-${scheme}.png`;
}

async function render(mark: string, px: number, py: number, bg: string): Promise<Buffer> {
	const size = Math.min(Math.round(Math.min(px, py) * MARK_FRACTION), MARK_MAX_PX);
	// `density` drives the SVG rasteriser: the default 72dpi renders the
	// 512-unit viewBox at 512px and then resizes, which softens the stroke's
	// rounded caps on the larger iPad marks. Scale it so the SVG rasterises at
	// (or above) the final size.
	const density = Math.max(72, Math.ceil((size / 512) * 72) + 72);
	const glyph = await sharp(Buffer.from(mark), { density })
		.resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
		.png()
		.toBuffer();
	return await sharp({ create: { width: px, height: py, channels: 4, background: bg } })
		.composite([{ input: glyph, gravity: 'centre' }])
		// The image is a flat field plus one small gradient mark, so a palette
		// holds it losslessly-enough at a fraction of the truecolour size
		// (~6 KB vs ~25 KB for a 1290x2796).
		.png({ palette: true, compressionLevel: 9, effort: 10 })
		.toBuffer();
}

/**
 * One `<link>`, on a single line. app.html is not prettier-ignored, so the
 * whole file goes back through prettier at the end of the run — which reflows
 * these onto four lines each. That costs ~1.1 KB raw (~11 bytes gzipped) over
 * the single-line form and is worth it to keep `pnpm format:check` green
 * without carving an exception out of the formatter for this file.
 */
function linkTag(d: Device, orientation: 'portrait' | 'landscape', scheme: string): string {
	const [px, py] =
		orientation === 'portrait' ? [d.w * d.dpr, d.h * d.dpr] : [d.h * d.dpr, d.w * d.dpr];
	// device-width/height always describe the panel in its natural (portrait)
	// orientation — they do NOT swap with `orientation`. The IMAGE does.
	const media = [
		`(device-width:${d.w}px)`,
		`(device-height:${d.h}px)`,
		`(-webkit-device-pixel-ratio:${d.dpr})`,
		`(orientation:${orientation})`,
		`(prefers-color-scheme:${scheme})`,
	].join(' and ');
	return `<link rel="apple-touch-startup-image" media="${media}" href="/splash/${fileName(px, py, scheme)}">`;
}

/** Set once `generate()` has begun replacing static/splash/. See main(). */
let swapping = false;

async function main(): Promise<void> {
	try {
		await generate();
	} finally {
		// Clean up a partial render, which would otherwise sit in `static/` —
		// where `pnpm build` copies it wholesale into `build/client/` and serves
		// it, and where `git add -A` would happily commit it. The guard test only
		// reads `static/splash/`, so nothing else would notice.
		//
		// But NOT once the swap has started. In that window static/splash/ has
		// already been removed, so if the rename is what failed then staging
		// holds the only surviving copy of the images — deleting it here would
		// turn a recoverable failure into total loss. Leave it for the operator
		// (`mv static/.splash-staging static/splash`), or just re-run: `git
		// checkout -- static/splash` restores the committed set either way.
		if (!swapping) await rm(fileURLToPath(stagingDir), { recursive: true, force: true });
	}
}

async function generate(): Promise<void> {
	// Reset so the flag means "mid-swap", not "a swap happened once" — it is
	// module state, and a second call in one process would otherwise inherit it.
	swapping = false;
	const mark = await loadMark();
	// Render into a staging directory and swap it in only once every image has
	// been written. Wiping static/splash/ up front instead would mean a single
	// failed render — a transient ENOSPC, an OOM on the 2048x2732 iPad canvas —
	// leaves a tree where EVERY href in app.html dangles, not just the one that
	// failed. The guard test catches that in CI, but locally it's a broken
	// commit away.
	await rm(fileURLToPath(stagingDir), { recursive: true, force: true });
	await mkdir(fileURLToPath(stagingDir), { recursive: true });

	const tags: string[] = [];
	// Guards against rendering the same file twice. In practice that only
	// happens if DEVICES ever gains a duplicate geometry row — orientations
	// can't collide with each other, since portrait names always have py > px
	// and landscape the reverse. Cheap insurance, not an active dedupe.
	const rendered = new Set<string>();

	for (const scheme of SCHEMES) {
		for (const d of DEVICES) {
			for (const orientation of ['portrait', 'landscape'] as const) {
				const [px, py] =
					orientation === 'portrait' ? [d.w * d.dpr, d.h * d.dpr] : [d.h * d.dpr, d.w * d.dpr];
				const name = fileName(px, py, scheme.name);
				if (!rendered.has(name)) {
					rendered.add(name);
					const buf = await render(mark, px, py, scheme.bg);
					await writeFile(fileURLToPath(new URL(name, stagingDir)), buf);
				}
				tags.push(linkTag(d, orientation, scheme.name));
			}
		}
	}

	// Build the new app.html IN FULL before touching static/splash/, so that a
	// missing marker (a bad rebase is the realistic way) aborts with the tree
	// untouched. Validating after the swap would exit non-zero having already
	// replaced every PNG — the filenames encode only geometry, so the change
	// would be invisible in `git status` as anything but "88 files modified",
	// with no app.html edit to explain it.
	const html = await readFile(appHtmlPath, 'utf-8');
	const start = html.indexOf(START_MARKER);
	const end = html.indexOf(END_MARKER);
	if (start === -1 || end === -1 || end < start) {
		throw new Error(`Missing ${START_MARKER} / ${END_MARKER} markers in ${appHtmlPath}.`);
	}
	// Match the indentation the markers sit at, then hand the whole file to
	// prettier — it owns the final shape (see linkTag), and running it here
	// keeps `pnpm gen:splash && pnpm format:check` idempotent.
	const indent = /(?:^|\n)([\t ]*)$/.exec(html.slice(0, start))?.[1] ?? '\t\t';
	const block = tags.map((t) => `${indent}${t}`).join('\n');
	const spliced = `${html.slice(0, start)}${START_MARKER}\n${block}\n${indent}${html.slice(end)}`;
	const config = await resolveConfig(appHtmlPath);
	const formatted = await format(spliced, { ...config, filepath: appHtmlPath });

	// Everything that can fail has now succeeded. Commit both halves. `rename`
	// needs the destination gone first, so there is an unavoidable instant with
	// no static/splash/ — `swapping` tells the cleanup in main() to keep its
	// hands off the staged copy from here on.
	swapping = true;
	await rm(fileURLToPath(outDir), { recursive: true, force: true });
	await rename(fileURLToPath(stagingDir), fileURLToPath(outDir));
	await writeFile(appHtmlPath, formatted);

	const names = await readdir(fileURLToPath(outDir));
	const bytes = (
		await Promise.all(
			names.map(async (n) => (await readFile(fileURLToPath(new URL(n, outDir)))).byteLength),
		)
	).reduce((a, b) => a + b, 0);
	process.stdout.write(
		`${names.length} images (${(bytes / 1024).toFixed(0)} KB), ` +
			`${tags.length} link tags (${(Buffer.byteLength(block) / 1024).toFixed(1)} KB)\n`,
	);
}

await main();
