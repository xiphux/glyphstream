/* @vitest-environment happy-dom */

/**
 * Component test for GalleryTimelineRail.
 *
 * Covers the discrete (click / keyboard) jump path and rendering. The
 * pointer-drag scrub relies on getBoundingClientRect geometry, which happy-dom
 * stubs to zeros, so it's exercised manually/e2e rather than here.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import GalleryTimelineRail from '$lib/components/GalleryTimelineRail.svelte';

const periods = [
	{ key: '2026-06', count: 5 },
	{ key: '2026-05', count: 2 },
	{ key: '2025-12', count: 9 },
];

describe('GalleryTimelineRail', () => {
	it('renders one tick button per period with month aria-labels', () => {
		render(GalleryTimelineRail, { props: { periods, onjump: vi.fn() } });
		expect(screen.getByRole('button', { name: 'Jump to June 2026' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Jump to May 2026' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Jump to December 2025' })).toBeTruthy();
	});

	it('renders nothing when there are no periods', () => {
		render(GalleryTimelineRail, { props: { periods: [], onjump: vi.fn() } });
		expect(screen.queryByRole('button')).toBeNull();
	});

	it('clicking a tick calls onjump with that month key', async () => {
		const onjump = vi.fn();
		render(GalleryTimelineRail, { props: { periods, onjump } });
		await userEvent.click(screen.getByRole('button', { name: 'Jump to December 2025' }));
		expect(onjump).toHaveBeenCalledWith('2025-12');
	});

	it('shows a year marker at year boundaries (newest month + first of an older year)', () => {
		render(GalleryTimelineRail, { props: { periods, onjump: vi.fn() } });
		// 2026 (first period) and 2025 (year change) are boundaries; 2026-05 is not.
		expect(screen.getByText('2026')).toBeTruthy();
		expect(screen.getByText('2025')).toBeTruthy();
	});
});
