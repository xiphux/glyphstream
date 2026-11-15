/**
 * The canvas pane's slide is instant under prefers-reduced-motion.
 *
 * `slidePane` drives the slide from a per-frame `tick`, which Svelte calls with
 * t=0 to set the starting frame before anything plays (the test setup's
 * `animate()` stub then never advances it). So a pane that is going to slide
 * mounts pushed off-screen; one that isn't is left on its class-driven styles.
 *
 * `prefersReducedMotion` is constructed when `svelte/motion` loads, from
 * `window.matchMedia`, so the stub is installed hoisted, before any import, and
 * reads a flag each test sets.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import CanvasPane from '#lib/components/chat/CanvasPane.svelte';
import type { CanvasVersion } from '#lib/types/api.js';

const media = vi.hoisted(() => {
	const state = { reduce: false };
	window.matchMedia = (query: string) =>
		({
			media: query,
			get matches() {
				return query.includes('prefers-reduced-motion: reduce') && state.reduce;
			},
			addEventListener() {},
			removeEventListener() {},
			addListener() {},
			removeListener() {},
			onchange: null,
			dispatchEvent: () => false,
		}) as MediaQueryList;
	return state;
});

const doc: CanvasVersion = {
	artifactId: 'a1',
	versionId: 'v1',
	title: 'My Doc',
	content: 'body',
	contentHtml: '<p>body</p>',
	versionNumber: 1,
	editSource: 'agent',
};

/** The pane's inline transform right after an intro has set its first frame. */
async function introTransform(): Promise<string> {
	render(CanvasPane, {
		props: {
			doc,
			docs: [doc],
			changed: false,
			onClose: () => {},
			onSwitch: () => {},
			onHighlightSettled: () => {},
		},
		intro: true,
	});
	await tick();
	await Promise.resolve();
	return screen.getByRole('complementary', { name: 'Canvas' }).style.transform;
}

describe('CanvasPane slide', () => {
	it('starts off-screen when motion is allowed', async () => {
		media.reduce = false;
		expect(await introTransform()).toBe('translateX(100%)');
	});

	it('does not slide under prefers-reduced-motion', async () => {
		media.reduce = true;
		expect(await introTransform()).toBe('');
	});
});
