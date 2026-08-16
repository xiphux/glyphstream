/* @vitest-environment happy-dom */

/**
 * Renders the debug panel against stubbed Performance entries — the wiring
 * between `readDebugSources` (which touches globals) and the markup, which the
 * pure-logic test in tests/unit/debug-info.test.ts can't reach.
 *
 * The `open` gate is the part worth pinning: the read happens in an $effect
 * precisely so it never runs during SSR, where there is no navigation entry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import DebugPanel from '$lib/components/DebugPanel.svelte';

const NAV = {
	entryType: 'navigation',
	workerStart: 100,
	fetchStart: 130,
	requestStart: 150,
	responseStart: 950,
	responseEnd: 1000,
	domInteractive: 1400,
	loadEventEnd: 1800,
	transferSize: 42_000,
	serverTiming: [{ name: 'ssr', duration: 620 }],
};

const RESOURCES = [
	{ entryType: 'resource', name: 'https://x/_app/immutable/nodes/0.abc.js', transferSize: 12_000 },
	{ entryType: 'resource', name: 'https://x/_app/immutable/chunks/a.def.js', transferSize: 0 },
];

beforeEach(() => {
	vi.stubGlobal('__APP_VERSION__', '9.9.9');
	vi.spyOn(performance, 'getEntriesByType').mockImplementation((type: string) => {
		if (type === 'navigation') return [NAV] as unknown as PerformanceEntryList;
		if (type === 'resource') return RESOURCES as unknown as PerformanceEntryList;
		if (type === 'paint') {
			return [
				{ name: 'first-contentful-paint', startTime: 1150 },
			] as unknown as PerformanceEntryList;
		}
		return [];
	});
	vi.stubGlobal(
		'matchMedia',
		vi.fn(() => ({ matches: true }) as unknown as MediaQueryList),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('DebugPanel', () => {
	it('renders nothing until opened', () => {
		render(DebugPanel, { props: { open: false, onClose: () => {} } });
		expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
		// The whole reason the read is deferred to an $effect: no globals
		// touched while closed, so SSR never reaches for a navigation entry.
		expect(performance.getEntriesByType).not.toHaveBeenCalled();
	});

	it('shows the split timings once open', () => {
		render(DebugPanel, { props: { open: true, onClose: () => {} } });
		const dialog = screen.getByRole('dialog');
		expect(dialog).toHaveTextContent('620 ms'); // server
		expect(dialog).toHaveTextContent('180 ms'); // network = TTFB - server
		expect(dialog).toHaveTextContent('30 ms'); // service-worker startup
		expect(dialog).toHaveTextContent('9.9.9');
		expect(dialog).toHaveTextContent('standalone');
	});

	it('is a plain dialog, not an alertdialog', () => {
		// alertdialog is for destructive confirmations; this only presents.
		render(DebugPanel, { props: { open: true, onClose: () => {} } });
		expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
		expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
	});
});
