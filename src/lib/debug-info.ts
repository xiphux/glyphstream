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
	/** When the fetch started, on the same clock as the navigation entry. */
	startTime: number;
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

/**
 * Coarse, human-scale duration for the server's uptime. Precision is pointless
 * here — the only readings that matter are "seconds" (this request was served
 * by a container that had just started, so a slow SSR is a cold start) and
 * "anything else" (it wasn't, so look elsewhere).
 */
function uptime(msTotal: number): string {
	const secs = Math.round(msTotal / 1000);
	if (secs < 90) return `${secs} s`;
	const mins = Math.round(secs / 60);
	if (mins < 90) return `${mins} min`;
	const hours = Math.floor(mins / 60);
	if (hours < 48) {
		const rem = mins % 60;
		return rem ? `${hours} h ${rem} min` : `${hours} h`;
	}
	return `${Math.floor(hours / 24)} d`;
}

export function buildDebugSections(s: DebugSources): DebugSection[] {
	const nav = s.navigation;
	const load: DebugRow[] = [];
	// Reported in the Environment section rather than with the load timings —
	// it describes the server, not this request. Set from Server-Timing below
	// when the response carried it (signed-in documents only).
	let procUptimeMs: number | null = null;
	// Same placement rationale as procUptimeMs: it describes the server's state
	// going into this request, not a phase of it.
	let idleMs: number | null = null;

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
		const timing = (name: string): number | null =>
			nav.serverTiming?.find((e) => e.name === name)?.duration ?? null;
		const ssr = timing('ssr');
		procUptimeMs = timing('proc');
		idleMs = timing('idle');
		// From fetchStart, NOT requestStart. requestStart is stamped after DNS,
		// TCP and the TLS handshake, so measuring from there drops connection
		// setup out of both rows — it lands in neither `Server` nor `Network`
		// and appears nowhere in the panel. On a cold iOS launch over cellular,
		// the case this whole readout exists for, that is routinely 100-500 ms
		// of the wait, and its absence makes the wire look fine when it wasn't.
		// fetchStart is also the conventional TTFB origin.
		const ttfb = span(nav.fetchStart, nav.responseStart);
		// Everything in TTFB that wasn't the server: connection setup, request
		// and response flight time. Clamped at 0 — the two clocks are measured
		// at different ends and rounding can cross over on a fast local hop.
		const network = ttfb !== null && ssr !== null ? Math.max(0, ttfb - ssr) : null;

		// The parts of that total. Absent from a server predating them, and from
		// one that never stamped a Server-Timing at all, so each is optional and
		// the row degrades to the bare headline number.
		const breakdown: string[] = [];
		// On the dev server this is dominated by Vite compiling the route on
		// demand — seconds, routinely, and nothing to do with how the deployed
		// app behaves. Saying so beats letting a 5s dev reading get taken for a
		// production problem.
		if (s.dev) breakdown.push('incl. Vite compile');
		const auth = timing('auth');
		const render = timing('render');
		const zip = timing('zip');
		// Session lookup, and on a process's first request the lazy SQLite open
		// + migrate() that rides along with it.
		if (auth !== null) breakdown.push(`auth ${ms(auth)}`);
		// Load functions + SSR render — where a load blocking on something
		// off-box shows up.
		if (render !== null) breakdown.push(`render ${ms(render)}`);
		// Omitted below a millisecond: COMPRESS_DYNAMIC is off by default, and
		// a permanent "zip 0 ms" reads as a measurement rather than an opt-out.
		if (zip !== null && zip >= 1) breakdown.push(`zip ${ms(zip)}`);

		// CPU the server actually burned, against the wall clock `ssr` reports.
		// A large gap means the process was WAITING rather than working — cold
		// SQLite pages coming off the volume, or its own heap being faulted back
		// in after an idle host reclaimed it — and in `ssr` alone that reads
		// exactly like honest work. `major faults` names the second mechanism:
		// nonzero means memory that was no longer resident had to be fetched back.
		// Its own row rather than another clause on the breakdown note above,
		// because that note's contract is "these sum to the total" and this is a
		// second decomposition of the same span, not a fourth part of it.
		const cpu = timing('cpu');
		const faults = timing('fault');
		// Read against `cpu` rather than on its own. A stall with `cpu` to match is
		// synchronous JavaScript holding the loop. A stall with almost NO cpu is a
		// blocking syscall — node:sqlite is synchronous, so a read that misses the
		// page cache stalls the entire process for the length of the physical I/O
		// while burning nothing, which `cpu` alone reports as an idle server. That
		// pairing is the one the panel exists to surface.
		const lag = timing('lag');
		const cpuRows: DebugRow[] =
			cpu === null
				? []
				: [
						{
							label: 'Server CPU',
							value: ms(cpu),
							note: [
								ssr === null || ssr <= 0
									? null
									: // Over 100% is normal, not a glitch: these counters are
										// process-wide, so the GC and libuv's threadpool contribute
										// CPU that ran on other threads alongside this request. Said
										// in words rather than printed as "122%", which reads as a
										// broken measurement and costs the row its credibility right
										// when someone is deciding whether to trust it. Either way
										// the reading is unambiguous — over wall means the server was
										// working, and only a figure well under it means waiting.
										cpu > ssr
										? '>100% of wall (other threads)'
										: `${Math.round((cpu / ssr) * 100)}% of wall`,
								faults === null ? null : `${faults} major fault${faults === 1 ? '' : 's'}`,
							]
								.filter((part): part is string => part !== null)
								.join(' · '),
						},
					];

		load.push(
			{
				label: 'Server (SSR)',
				value: orDash(ssr),
				...(breakdown.length ? { note: breakdown.join(' · ') } : {}),
			},
			...cpuRows,
			...(lag === null
				? []
				: [
						{
							label: 'Event loop',
							value: ms(lag),
							note: 'longest stall while this load was open — read against Server CPU',
						},
					]),
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

	// Bounded to the initial load, not the whole document lifetime. The resource
	// buffer keeps accumulating as you browse, and this panel's own premise is
	// that client-side navigation never replaces the document — so an unbounded
	// count folds in every route chunk lazy-loaded since (settings, gallery,
	// shiki, pyodide) and reports a cold start as far more expensive than it
	// was. It would also count the panel's OWN chunk, which is lazy-loaded on
	// open: on a fully-cached launch, where the honest answer is "0 from
	// network", it would say 1. A diagnostic must not be visible in its own
	// measurement.
	// `loadEventEnd` is 0 until the load event fires, and one hung subresource
	// (an <img> pointing at a dead upstream) keeps it there for the life of the
	// document — so keying on it alone would silently restore the unbounded
	// count in precisely a degraded session. `domInteractive` is set much
	// earlier and never rolls back, so it's the fallback; it lands slightly
	// before the last chunk of the initial load, which under-counts rather than
	// over-counts. Erring toward "too few" is right for a diagnostic: it can't
	// invent network traffic that didn't happen.
	const loadEnd = nav ? nav.loadEventEnd || nav.domInteractive || null : null;
	const chunks = s.resources.filter(
		(r) => r.name.includes(IMMUTABLE_PREFIX) && (loadEnd === null || r.startTime <= loadEnd),
	);
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
				// How long the server process had been up when it served this
				// document — the first thing to check against a slow "Server
				// (SSR)", since a process's first request pays for the lazy
				// SQLite open and a cold model-list fetch that every later one
				// gets free. Absent on a server that doesn't stamp it.
				...(procUptimeMs !== null ? [{ label: 'Server uptime', value: uptime(procUptimeMs) }] : []),
				// How long the server had gone without serving a request before this
				// one. Reported next to uptime because it answers the question uptime
				// cannot: a slow load on a process that has been up for a day is not a
				// cold start, but if that same process had been idle for eight hours,
				// its pages have been reclaimable that whole time and its volume may
				// have spun down. This is the variable that separates the slow launches
				// from the quick ones when uptime does not.
				...(idleMs !== null ? [{ label: 'Idle before this load', value: uptime(idleMs) }] : []),
			],
		},
	];
}

/**
 * Gather the live values. Browser-only; every lookup is defensive because this
 * runs on whatever the user's device happens to support, and a diagnostic that
 * throws is worse than one that prints a dash.
 */
export async function readDebugSources(version: string): Promise<DebugSources> {
	// Down-cast to the concrete DOM types (both extend PerformanceEntry), which
	// then satisfy the structural *Like interfaces without an `unknown` hop.
	// Read synchronously, BEFORE the await below, so the timings describe the
	// moment the panel was opened rather than a tick later.
	const nav = performance.getEntriesByType('navigation')[0] as
		PerformanceNavigationTiming | undefined;
	const paint = performance.getEntriesByType('paint');
	const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
	const standalone = window.matchMedia('(display-mode: standalone)').matches;
	const online = navigator.onLine;

	// A controller answers "is a worker driving this page", which is NOT the
	// same question as "is one installed" — and the gap between them is now a
	// normal, long-lived state: since the worker stopped calling skipWaiting()
	// on install, an update sits in `waiting` until the user accepts it. Keying
	// only off `controller` reported that device as having no worker at all,
	// which is the wrong answer to the one thing this panel is for. Hence the
	// async hop: registration state isn't available synchronously.
	let serviceWorker: DebugSources['serviceWorker'] = 'unsupported';
	if ('serviceWorker' in navigator) {
		if (navigator.serviceWorker.controller) {
			serviceWorker = 'controlled';
		} else {
			// Rejects outside a secure context; a dash-equivalent beats a throw.
			const reg = await navigator.serviceWorker.getRegistration().catch(() => undefined);
			serviceWorker = reg ? 'registered' : 'none';
		}
	}

	return {
		version,
		navigation: nav,
		paint,
		resources,
		standalone,
		serviceWorker,
		online,
		dev: import.meta.env.DEV,
	};
}
