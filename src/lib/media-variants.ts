/**
 * The display-sized copies an image is served at, and the `srcset` built from
 * them. Shared by the server (`server/media/display-variant.ts` encodes these
 * sizes) and the lightbox, so the two can't disagree on what exists.
 *
 * A fixed ladder rather than any width a client asks for: each size is a decode
 * and a file per image, so an open-ended `?w=` would let one client fill the
 * derived volume and the generation slots. Sizes are the LONG side.
 *
 * - 1280: a phone at full width (~390 CSS px at 3x), and the chat bubble. An
 *   image from the generation relay has it from persist (any other image from
 *   its first bubble view), so a lightbox opened from the thread usually finds
 *   it in the browser cache already.
 * - 2048: a tablet, or a desktop's lightbox at 2x, which is bounded by the
 *   window's height. Made on first request; only an original larger than 1280
 *   lists it.
 *
 * Past the top size the original itself is the next candidate. An original no
 * larger than a size is still served AT that size, re-encoded as WebP at its own
 * resolution — never enlarged — which is how a 1024 px generated PNG reaches a
 * phone as a tenth of the bytes. Download and Share use the original.
 */
import type { MediaKind } from './types/api.js';

/** One entry of a lightbox carousel. The size is optional so a host that only
 *  knows ids still works; such a slide shows the original. */
export interface LightboxSlide {
	id: string;
	kind: MediaKind;
	width?: number | null;
	height?: number | null;
}

/** Long-side sizes, ascending. The first is the default `/display`. */
export const DISPLAY_SIZES = [1280, 2048] as const;
export type DisplaySize = (typeof DISPLAY_SIZES)[number];

export function isDisplaySize(n: number): n is DisplaySize {
	return (DISPLAY_SIZES as readonly number[]).includes(n);
}

/** The URL of one size. `query` carries an existing parameter (`trash=1`). */
export function displayUrl(id: string, size: DisplaySize, query = ''): string {
	const params = new URLSearchParams(query);
	if (size !== DISPLAY_SIZES[0]) params.set('size', String(size));
	const qs = params.toString();
	return `/api/media/${id}/display${qs ? `?${qs}` : ''}`;
}

export interface ResponsiveImage {
	src: string;
	srcset: string;
	sizes: string;
	/**
	 * The CSS width to draw it at, in its container's query units: its own pixel
	 * width, or the container's space if that's smaller — what a plain `src` drew
	 * under `max-width`/`max-height`. Needed because a `w`-descriptor srcset makes
	 * the image's intrinsic size the `sizes` length, not its pixels: left to that,
	 * a 512 px image fills a desktop's lightbox (2.4x, blurry), and a large one
	 * draws at `sizes`' estimate of the space rather than the space. The caller's
	 * container must set `container-type: size`.
	 */
	drawWidth: string;
}

/**
 * `src` / `srcset` / `sizes` for an image shown fitted to the viewport (the
 * lightbox). Null without a known size: a `w` descriptor needs the real width,
 * and the caller then shows the original as before.
 *
 * Each candidate's width is what that copy actually is — the original scaled to
 * fit the size, never enlarged — so the browser's choice is honest. The list
 * stops at the first size that holds the whole original, and lists the original
 * only when it's larger than every size.
 */
export function lightboxImage(
	id: string,
	width: number | null | undefined,
	height: number | null | undefined,
	query = '',
): ResponsiveImage | null {
	if (!width || !height) return null;
	const ratio = +(width / height).toFixed(3);
	const long = Math.max(width, height);
	const candidates: string[] = [];
	for (const size of DISPLAY_SIZES) {
		const scale = Math.min(1, size / long);
		candidates.push(`${displayUrl(id, size, query)} ${Math.round(width * scale)}w`);
		if (long <= size) break;
	}
	const top = DISPLAY_SIZES[DISPLAY_SIZES.length - 1];
	const original = `/api/media/${id}/content${query ? `?${query}` : ''}`;
	if (long > top) candidates.push(`${original} ${width}w`);
	return {
		src: displayUrl(id, DISPLAY_SIZES[0], query),
		srcset: candidates.join(', '),
		// Fitted (object-contain in the space the lightbox leaves): the shown
		// width is that space's, or its height's share of it for an image shaped
		// taller than the space.
		sizes: `min(calc(100vw - ${LIGHTBOX_CHROME_X}px), calc((100vh - ${LIGHTBOX_CHROME_Y}px) * ${ratio}))`,
		drawWidth: `min(${width}px, 100cqw, calc(100cqh * ${ratio}))`,
	};
}

/**
 * What the lightbox's own furniture takes from the viewport around the image:
 * side padding, and the header plus the caption strip. Measured (32 and 216 on a
 * phone, an iPad and a desktop with the caption strip; a wrapped caption or the
 * action rows take more, a lightbox with no caption strip less — 76). Used only
 * in `sizes`, to choose a copy: the drawn size comes from `drawWidth`. Assuming
 * the full viewport height instead overstated a desktop's image by a third,
 * enough to pick the original over the 2048 copy. The cost of these being off
 * is only which copy is fetched — a larger one than needed where the furniture
 * is bigger, and where it's smaller (no caption strip) a copy picked for a box
 * up to 140 px shorter than the one it's drawn in.
 */
const LIGHTBOX_CHROME_X = 32;
const LIGHTBOX_CHROME_Y = 216;
