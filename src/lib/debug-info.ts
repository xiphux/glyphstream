/**
 * "Stats for nerds" — the numbers behind a page load, formatted for the panel
 * behind the sidebar version number.
 *
 * The point of this existing at all is that the load worth measuring is the
 * one you can't attach a debugger to: an iOS home-screen app's cold launch.
 * Web Inspector needs a Mac and a cable, and by the time you're attached the
 * launch is over. What makes reading it after the fact work is that
 * `PerformanceNavigationTiming` describes the DOCUMENT — and SvelteKit's
 * client-side navigation never replaces the document, so the cold-launch entry
 * is still there however long later the user opens this panel.
 *
 * Split into a pure `buildDebugSections` over plain data plus a thin
 * `readDebugSources` that touches globals, so the formatting and the
 * arithmetic are unit-testable without a DOM.
 */

/** Structural subsets of the DOM types — the real entries satisfy these, and
 *  a test can hand-write one without fabricating a whole Performance entry. */
export interface NavTimingLike {
	fetchStart: number;
	/** 0 when no service worker was involved in the navigation. */
	workerStart: number;
	requestStart: number;
	responseStart: number;
	responseEnd: number;
	domInteractive: number;
	loadEventEnd: number;
	/** 0 for a cache hit; bytes over the wire otherwise. */
	transferSize: number;
	serverTiming?: ReadonlyArray<{ readonly name: string; readonly duration: number }>;
}

export interface ResourceTimingLike {
	name: string;
	transferSize: number;
}

export interface PaintTimingLike {
	name: string;
	startTime: number;
}

export interface DebugSources {
	version: string;
	navigation: NavTimingLike | undefined;
	paint: readonly PaintTimingLike[];
	resources: readonly ResourceTimingLike[];
	/** Launched from the home screen rather than a browser tab. */
	standalone: boolean;
	serviceWorker: 'controlled' | 'registered' | 'unsupported' | 'none';
	online: boolean;
	/** Vite dev server rather than a production build. Changes what half of
	 *  these numbers MEAN, so the panel says so rather than letting a dev-server
	 *  reading get compared against a production one. */
	dev: boolean;
}

export interface DebugRow {
	label: string;
	value: string;
	/** Rendered small and muted under the value; use sparingly. */
	note?: string;
}

export interface DebugSection {
	title: string;
	rows: DebugRow[];
}

/** Hashed client bundles. Matching on the path keeps CSS in the count too. */
const IMMUTABLE_PREFIX = '/_app/immutable/';

const ms = (v: number): string => `${Math.round(v)} ms`;

function kb(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
}

/** A timing is only meaningful when both ends actually happened. */
function span(from: number, to: number): number | null {
	if (!(from > 0) || !(to > 0) || to < from) return null;
	return to - from;
}

const orDash = (v: number | null): string => (v === null ? '—' : ms(v));

export function buildDebugSections(s: DebugSources): DebugSection[] {
	const nav = s.navigation;
	const load: DebugRow[] = [];

	if (!nav) {
		load.push({
			label: 'Navigation timing',
			value: 'unavailable',
			note: 'The browser exposed no navigation entry for this document.',
		});
	} else {
		// Server-Timing (see hooks.server.ts) is what separates "the container
		// had just restarted" from "the network was slow" — without it the two
		// are pooled into one indistinguishable TTFB.
		const ssr = nav.serverTiming?.find((e) => e.name === 'ssr')?.duration ?? null;
		const ttfb = span(nav.requestStart, nav.responseStart);
		// Everything in TTFB that wasn't the server: connection setup, request
		// and response flight time. Clamped at 0 — the two clocks are measured
		// at different ends and rounding can cross over on a fast local hop.
		const network = ttfb !== null && ssr !== null ? Math.max(0, ttfb - ssr) : null;

		load.push(
			{
				label: 'Server (SSR)',
				value: orDash(ssr),
				// On the dev server this is dominated by Vite compiling the
				// route on demand — seconds, routinely, and nothing to do with
				// how the deployed app behaves. Saying so beats letting a 5s
				// dev reading get taken for a production problem.
				...(s.dev ? { note: 'incl. Vite compile' } : {}),
			},
			{ label: 'Network', value: orDash(network), note: ttfb !== null ? `${ms(ttfb)} TTFB` : '' },
			{
				label: 'HTML',
				value: orDash(span(nav.responseStart, nav.responseEnd)),
				note: nav.transferSize > 0 ? kb(nav.transferSize) : 'from cache',
			},
			{
				// Deliberately NOT labelled "Service worker" — that label is
				// taken in Environment for the worker's current state, and the
				// two legitimately disagree ("not involved" here alongside
				// "controlled" there is the normal first load of a session).
				// Two rows with one label reads as a contradiction.
				label: 'Worker start',
				// workerStart..fetchStart is the worker's own startup — the gap
				// before the navigation fetch even begins. On a cold iOS launch
				// the worker process has to boot too, and this is the only place
				// that cost is visible.
				value: nav.workerStart > 0 ? orDash(span(nav.workerStart, nav.fetchStart)) : 'not involved',
			},
			{
				label: 'First paint',
				value: orDash(s.paint.find((p) => p.name === 'first-contentful-paint')?.startTime ?? null),
			},
			{ label: 'Interactive', value: orDash(nav.domInteractive || null) },
			{ label: 'Load complete', value: orDash(nav.loadEventEnd || null) },
		);
	}

	const chunks = s.resources.filter((r) => r.name.includes(IMMUTABLE_PREFIX));
	// transferSize 0 means it never hit the network. That single number answers
	// "did this launch re-download the bundle" — the question behind a slow
	// cold start right after a deploy.
	const fromNetwork = chunks.filter((r) => r.transferSize > 0);
	const downloaded = fromNetwork.reduce((a, r) => a + r.transferSize, 0);

	return [
		{ title: 'This load', rows: load },
		{
			title: 'Assets',
			// The dev server has no /_app/immutable/ at all — Vite serves
			// unhashed ES modules — so the counts are structurally 0 there, not
			// "nothing was downloaded". Reporting 0 chunks / 0 B on a dev load
			// is the panel lying by omission about which build it's looking at.
			rows: s.dev
				? [{ label: 'App chunks', value: 'n/a', note: 'dev server serves unhashed modules' }]
				: [
						{
							label: 'App chunks',
							value: String(chunks.length),
							note: chunks.length ? `${fromNetwork.length} from network` : '',
						},
						{ label: 'Downloaded', value: kb(downloaded) },
					],
		},
		{
			title: 'Environment',
			rows: [
				{ label: 'Version', value: s.version },
				{ label: 'Mode', value: s.dev ? 'development' : 'production' },
				{ label: 'Display', value: s.standalone ? 'standalone' : 'browser' },
				{ label: 'Service worker', value: s.serviceWorker },
				{ label: 'Connection', value: s.online ? 'online' : 'offline' },
			],
		},
	];
}

/**
 * Gather the live values. Browser-only; every lookup is defensive because this
 * runs on whatever the user's device happens to support, and a diagnostic that
 * throws is worse than one that prints a dash.
 */
export function readDebugSources(version: string): DebugSources {
	// Down-cast to the concrete DOM types (both extend PerformanceEntry), which
	// then satisfy the structural *Like interfaces without an `unknown` hop.
	const nav = performance.getEntriesByType('navigation')[0] as
		PerformanceNavigationTiming | undefined;
	let serviceWorker: DebugSources['serviceWorker'] = 'unsupported';
	if ('serviceWorker' in navigator) {
		serviceWorker = navigator.serviceWorker.controller ? 'controlled' : 'none';
	}
	return {
		version,
		navigation: nav,
		paint: performance.getEntriesByType('paint'),
		resources: performance.getEntriesByType('resource') as PerformanceResourceTiming[],
		standalone: window.matchMedia('(display-mode: standalone)').matches,
		serviceWorker,
		online: navigator.onLine,
		dev: import.meta.env.DEV,
	};
}
