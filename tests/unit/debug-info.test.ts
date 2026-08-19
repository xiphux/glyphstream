/**
 * The debug panel's arithmetic. Worth testing precisely because the panel is
 * the thing you reach for when something else is already wrong — a readout
 * that quietly reports a plausible-but-wrong number is worse than no readout,
 * since it sends you after the wrong cause.
 *
 * Covers the degradations too: no navigation entry, no Server-Timing, no
 * service worker, everything served from cache.
 */
import { describe, expect, it } from 'vitest';
import {
	buildDebugSections,
	type DebugSources,
	type NavTimingLike,
} from '../../src/lib/debug-info';

const nav: NavTimingLike = {
	workerStart: 100,
	fetchStart: 140, // 40ms of service-worker startup
	requestStart: 150,
	responseStart: 950, // 810ms TTFB, measured from fetchStart (140)
	responseEnd: 1000, // 50ms of HTML transfer
	domInteractive: 1400,
	loadEventEnd: 1800,
	transferSize: 42_000,
	serverTiming: [{ name: 'ssr', duration: 620 }],
};

function sources(over: Partial<DebugSources> = {}): DebugSources {
	return {
		version: '1.2.3',
		navigation: nav,
		paint: [{ name: 'first-contentful-paint', startTime: 1150 }],
		resources: [
			{ name: 'https://x/_app/immutable/nodes/0.abc.js', transferSize: 12_000, startTime: 10 },
			{ name: 'https://x/_app/immutable/chunks/a.def.js', transferSize: 0, startTime: 10 }, // cached
			{ name: 'https://x/_app/immutable/assets/app.ghi.css', transferSize: 4_000, startTime: 10 },
			{ name: 'https://x/api/conversations', transferSize: 9_999, startTime: 10 }, // not a chunk
		],
		standalone: true,
		serviceWorker: 'controlled',
		online: true,
		dev: false,
		...over,
	};
}

const rowsOf = (s: DebugSources, title: string) =>
	Object.fromEntries(
		buildDebugSections(s)
			.find((sec) => sec.title === title)!
			.rows.map((r) => [r.label, r]),
	);

describe('buildDebugSections', () => {
	it('splits TTFB into server and network using Server-Timing', () => {
		const rows = rowsOf(sources(), 'This load');
		expect(rows['Server (SSR)'].value).toBe('620 ms');
		// 810ms TTFB - 620ms of server = 190ms of connection setup + flight.
		expect(rows['Network'].value).toBe('190 ms');
		expect(rows['Network'].note).toBe('810 ms TTFB');
	});

	it('reports the service-worker startup gap, not the whole fetch', () => {
		// workerStart..fetchStart, i.e. the worker booting before the
		// navigation fetch begins — not requestStart, which would fold in
		// connection setup and read as a much bigger SW cost than it is.
		expect(rowsOf(sources(), 'This load')['Worker start'].value).toBe('40 ms');
	});

	it('says so when no service worker touched the navigation', () => {
		const s = sources({ navigation: { ...nav, workerStart: 0 } });
		expect(rowsOf(s, 'This load')['Worker start'].value).toBe('not involved');
	});

	it('falls back to a dash when the server sent no Server-Timing', () => {
		// Safari exposes it same-origin, but a proxy can strip it — the panel
		// must degrade rather than render "NaN ms" or silently show 0.
		const s = sources({ navigation: { ...nav, serverTiming: undefined } });
		const rows = rowsOf(s, 'This load');
		expect(rows['Server (SSR)'].value).toBe('—');
		expect(rows['Network'].value).toBe('—');
		// TTFB is still known and still the useful number.
		expect(rows['Network'].note).toBe('810 ms TTFB');
	});

	it('bills connection setup to Network rather than dropping it', () => {
		// requestStart (150) is stamped after DNS/TCP/TLS; fetchStart (140) is
		// before. Measuring TTFB from requestStart would silently lose that
		// window from both rows — on a cold cellular launch it's the biggest
		// single component of the wait, and the panel would read "wire is fine".
		const s = sources({ navigation: { ...nav, fetchStart: 140, requestStart: 640 } });
		const rows = rowsOf(s, 'This load');
		// 950 - 140 = 810 total, of which 620 was the server.
		expect(rows['Network'].note).toBe('810 ms TTFB');
		expect(rows['Network'].value).toBe('190 ms');
	});

	it('never reports negative network time when the clocks disagree', () => {
		// ssr is measured on the server, TTFB on the client; on a fast local
		// hop rounding can make ssr look longer than the whole TTFB.
		const s = sources({ navigation: { ...nav, serverTiming: [{ name: 'ssr', duration: 900 }] } });
		expect(rowsOf(s, 'This load')['Network'].value).toBe('0 ms');
	});

	it('counts only hashed app chunks, and only bills the ones off the network', () => {
		const rows = rowsOf(sources(), 'Assets');
		expect(rows['App chunks'].value).toBe('3'); // the /api/ row is excluded
		expect(rows['App chunks'].note).toBe('2 from network'); // the cached one isn't
		// 12000 + 4000, not the api row. Whole KB above 10 KiB, one decimal below.
		expect(rows['Downloaded'].value).toBe('16 KB');
	});

	it('counts only chunks from the initial load, not the whole session', () => {
		// The document outlives every client-side navigation, so the resource
		// buffer keeps growing: route chunks pulled later (settings, gallery,
		// shiki) would otherwise be billed to a cold start that never paid for
		// them. This also covers the panel's OWN chunk, which is lazy-loaded at
		// open time — well after loadEventEnd (1800) — so a fully-cached launch
		// still honestly reports zero from network instead of counting itself.
		const s = sources({
			resources: [
				{ name: 'https://x/_app/immutable/nodes/0.abc.js', transferSize: 0, startTime: 10 },
				// The panel's own chunk, fetched when the user opened it.
				{
					name: 'https://x/_app/immutable/chunks/DebugPanel.z.js',
					transferSize: 4_400,
					startTime: 90_000,
				},
				// A route visited mid-session.
				{
					name: 'https://x/_app/immutable/nodes/9.gallery.js',
					transferSize: 30_000,
					startTime: 50_000,
				},
			],
		});
		const rows = rowsOf(s, 'Assets');
		expect(rows['App chunks'].value).toBe('1');
		expect(rows['App chunks'].note).toBe('0 from network');
		expect(rows['Downloaded'].value).toBe('0 B');
	});

	it('reports a fully cached load as zero downloaded', () => {
		const s = sources({
			resources: [
				{ name: 'https://x/_app/immutable/nodes/0.abc.js', transferSize: 0, startTime: 10 },
			],
			navigation: { ...nav, transferSize: 0 },
		});
		expect(rowsOf(s, 'Assets')['Downloaded'].value).toBe('0 B');
		expect(rowsOf(s, 'This load')['HTML'].note).toBe('from cache');
	});

	it('degrades to a single note when there is no navigation entry', () => {
		const sections = buildDebugSections(sources({ navigation: undefined }));
		expect(sections.find((s) => s.title === 'This load')!.rows).toHaveLength(1);
		// The other sections still render — environment info doesn't depend on it.
		expect(rowsOf(sources({ navigation: undefined }), 'Environment')['Version'].value).toBe(
			'1.2.3',
		);
	});

	it('refuses to report dev-server asset counts as if they were real', () => {
		// There is no /_app/immutable/ on the dev server — Vite serves unhashed
		// modules — so the honest answer is "n/a", not "0 chunks, 0 B". The
		// latter reads as "nothing was downloaded", which is the opposite of
		// true and sends you looking for a caching win that doesn't exist.
		const rows = rowsOf(sources({ dev: true, resources: [] }), 'Assets');
		expect(rows['App chunks'].value).toBe('n/a');
		expect(rows['App chunks'].note).toMatch(/dev server/);
		expect(rows['Downloaded']).toBeUndefined();
	});

	it('flags that a dev-server SSR time includes Vite compilation', () => {
		// A multi-second dev SSR is Vite compiling the route on demand, not a
		// slow app. Unannotated, it looks like a production-grade problem.
		expect(rowsOf(sources({ dev: true }), 'This load')['Server (SSR)'].note).toMatch(/Vite/);
		expect(rowsOf(sources(), 'This load')['Server (SSR)'].note).toBeUndefined();
	});

	it('names which build the numbers came from', () => {
		expect(rowsOf(sources({ dev: true }), 'Environment')['Mode'].value).toBe('development');
		expect(rowsOf(sources(), 'Environment')['Mode'].value).toBe('production');
	});

	it('surfaces the environment the load happened in', () => {
		const rows = rowsOf(sources({ standalone: false, online: false }), 'Environment');
		expect(rows['Display'].value).toBe('browser');
		expect(rows['Connection'].value).toBe('offline');
		expect(rows['Service worker'].value).toBe('controlled');
	});
});

/**
 * The breakdown behind the headline SSR number, and the server's uptime.
 *
 * One opaque `ssr` number reported that a cold launch spent 2.35s on the
 * server and nothing about where — leaving "the container had just restarted",
 * "a load blocked on an upstream" and "compressing a big document" impossible
 * to tell apart from a reading taken hours after the fact, which is the only
 * kind this panel can get.
 */
describe('buildDebugSections — server phase breakdown', () => {
	const timed = (entries: Array<{ name: string; duration: number }>) =>
		sources({ navigation: { ...nav, serverTiming: [{ name: 'ssr', duration: 620 }, ...entries] } });

	it('breaks the SSR total into its phases', () => {
		const rows = rowsOf(
			timed([
				{ name: 'auth', duration: 4 },
				{ name: 'render', duration: 590 },
				{ name: 'zip', duration: 24 },
			]),
			'This load',
		);
		// Headline stays the total — the breakdown is the note under it.
		expect(rows['Server (SSR)'].value).toBe('620 ms');
		expect(rows['Server (SSR)'].note).toBe('auth 4 ms · render 590 ms · zip 24 ms');
	});

	it('omits compression when it did no work', () => {
		// COMPRESS_DYNAMIC is off by default, so `zip` is a sub-millisecond
		// passthrough on most deployments. A permanent "zip 0 ms" reads as a
		// measured cost rather than a feature that isn't switched on.
		const rows = rowsOf(
			timed([
				{ name: 'auth', duration: 4 },
				{ name: 'render', duration: 590 },
				{ name: 'zip', duration: 0.2 },
			]),
			'This load',
		);
		expect(rows['Server (SSR)'].note).toBe('auth 4 ms · render 590 ms');
	});

	it('keeps the dev-server caveat alongside the breakdown', () => {
		// Both are true on a dev load, and the Vite warning is the one that
		// stops a 5s reading being taken for a production problem.
		const s = timed([{ name: 'render', duration: 590 }]);
		const rows = rowsOf({ ...s, dev: true }, 'This load');
		expect(rows['Server (SSR)'].note).toBe('incl. Vite compile · render 590 ms');
	});

	it('degrades to the bare total against a server that sends no phases', () => {
		// A deployment still running the previous image stamps only `ssr`.
		const rows = rowsOf(sources(), 'This load');
		expect(rows['Server (SSR)'].value).toBe('620 ms');
		expect(rows['Server (SSR)'].note).toBeUndefined();
	});
});

describe('buildDebugSections — server uptime', () => {
	const withProc = (durationMs: number) =>
		sources({
			navigation: {
				...nav,
				serverTiming: [
					{ name: 'ssr', duration: 620 },
					{ name: 'proc', duration: durationMs },
				],
			},
		});

	it('reports a just-restarted process in seconds', () => {
		// The reading that matters most: a slow SSR on a process this young is
		// a cold start paying for the SQLite open, the MCP handshakes and the
		// model-list fetch that every later request gets free.
		expect(rowsOf(withProc(4_200), 'Environment')['Server uptime'].value).toBe('4 s');
	});

	it('coarsens longer uptimes', () => {
		expect(rowsOf(withProc(20 * 60_000), 'Environment')['Server uptime'].value).toBe('20 min');
		expect(rowsOf(withProc(9.2 * 3_600_000), 'Environment')['Server uptime'].value).toBe(
			'9 h 12 min',
		);
		expect(rowsOf(withProc(6 * 24 * 3_600_000), 'Environment')['Server uptime'].value).toBe('6 d');
	});

	it('reports a whole number of hours without a stray "0 min"', () => {
		expect(rowsOf(withProc(3 * 3_600_000), 'Environment')['Server uptime'].value).toBe('3 h');
	});

	it('omits the row entirely when the server did not send it', () => {
		// Unauthenticated documents don't carry `proc`, and neither does an
		// older server. An absent row beats a dash that looks like a failure.
		expect(rowsOf(sources(), 'Environment')['Server uptime']).toBeUndefined();
	});
});
