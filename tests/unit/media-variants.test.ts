/** The lightbox's srcset over the display-size ladder. */
import { describe, expect, it } from 'vitest';
import { DISPLAY_SIZES, displayUrl, isDisplaySize, lightboxImage } from '#lib/media-variants.js';

describe('displayUrl', () => {
	it('leaves the default size unparameterised, so the thread and lightbox share a cache entry', () => {
		expect(displayUrl('m', 1280)).toBe('/api/media/m/display');
		expect(displayUrl('m', 2048)).toBe('/api/media/m/display?size=2048');
		expect(displayUrl('m', 2048, 'trash=1')).toBe('/api/media/m/display?trash=1&size=2048');
	});
});

describe('isDisplaySize', () => {
	it('accepts only the ladder', () => {
		for (const s of DISPLAY_SIZES) expect(isDisplaySize(s)).toBe(true);
		expect(isDisplaySize(1000)).toBe(false);
		expect(isDisplaySize(NaN)).toBe(false);
	});
});

describe('lightboxImage', () => {
	it('is null without a known size', () => {
		expect(lightboxImage('m', null, null)).toBeNull();
		expect(lightboxImage('m', 1024, undefined)).toBeNull();
		expect(lightboxImage('m', 0, 0)).toBeNull();
	});

	it('serves an original that fits the first size as that one copy, at its own width', () => {
		// The common generated image: never enlarged, never the PNG.
		expect(lightboxImage('m', 1024, 1024)).toEqual({
			src: '/api/media/m/display',
			srcset: '/api/media/m/display 1024w',
			sizes: 'min(calc(100vw - 32px), calc((100vh - 216px) * 1))',
		});
	});

	it('stops at the first size that holds the whole original', () => {
		expect(lightboxImage('m', 1536, 1024)?.srcset).toBe(
			'/api/media/m/display 1280w, /api/media/m/display?size=2048 1536w',
		);
	});

	it('lists the original only past the top size, with honest widths for a portrait', () => {
		// 1000 × 3000: the long side is the height, so each copy's WIDTH is a third
		// of its size.
		const r = lightboxImage('m', 1000, 3000)!;
		expect(r.srcset).toBe(
			'/api/media/m/display 427w, /api/media/m/display?size=2048 683w, /api/media/m/content 1000w',
		);
		expect(r.sizes).toBe('min(calc(100vw - 32px), calc((100vh - 216px) * 0.333))');
	});

	it('carries the trash query on every candidate', () => {
		const r = lightboxImage('m', 4000, 3000, 'trash=1')!;
		expect(r.src).toBe('/api/media/m/display?trash=1');
		expect(r.srcset).toBe(
			'/api/media/m/display?trash=1 1280w, /api/media/m/display?trash=1&size=2048 2048w, /api/media/m/content?trash=1 4000w',
		);
	});
});
