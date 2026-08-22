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
		launchImage: null,
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
		// a cold start paying for the lazy SQLite open and a cold model-list
		// fetch that every later request gets free.
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

/**
 * The wall clock alone cannot tell "the server did 2.8s of work" from "the
 * server waited 2.4s to be allowed to work", and those have different fixes.
 * These cover the row that separates them.
 */
describe('buildDebugSections — server CPU vs wall', () => {
	const withUsage = (entries: Array<{ name: string; duration: number }>) =>
		sources({ navigation: { ...nav, serverTiming: [{ name: 'ssr', duration: 620 }, ...entries] } });

	it('reports CPU as a share of the wall clock, with the fault count', () => {
		const rows = rowsOf(
			withUsage([
				{ name: 'cpu', duration: 90 },
				{ name: 'fault', duration: 1203 },
			]),
			'This load',
		);
		expect(rows['Server CPU'].value).toBe('90 ms');
		// 90/620 — the whole point of the row. Six-sevenths of that request was
		// spent not running, and `ssr` on its own said nothing about it.
		expect(rows['Server CPU'].note).toBe('15% of wall · 1203 major faults');
	});

	it('does not accuse a busy server of waiting', () => {
		// The other reading: CPU tracking wall means the time was real work, and
		// the answer is to do less of it rather than to look at the host.
		const rows = rowsOf(
			withUsage([
				{ name: 'cpu', duration: 605 },
				{ name: 'fault', duration: 0 },
			]),
			'This load',
		);
		expect(rows['Server CPU'].note).toBe('98% of wall · 0 major faults');
	});

	it('explains CPU exceeding the wall clock instead of printing an impossible share', () => {
		// Routine, not a glitch — the counters are process-wide, so GC and libuv's
		// threadpool add CPU that ran on other threads. A literal "122% of wall"
		// reads as a broken measurement and costs the row the credibility it needs
		// at exactly the moment someone is deciding whether to believe it.
		const rows = rowsOf(
			withUsage([
				{ name: 'cpu', duration: 758 },
				{ name: 'fault', duration: 0 },
			]),
			'This load',
		);
		expect(rows['Server CPU'].note).toBe('>100% of wall (other threads) · 0 major faults');
	});

	it('does not report "1 major faults"', () => {
		const rows = rowsOf(
			withUsage([
				{ name: 'cpu', duration: 90 },
				{ name: 'fault', duration: 1 },
			]),
			'This load',
		);
		expect(rows['Server CPU'].note).toBe('15% of wall · 1 major fault');
	});

	it('keeps the share when the platform reports no fault counter', () => {
		const rows = rowsOf(withUsage([{ name: 'cpu', duration: 90 }]), 'This load');
		expect(rows['Server CPU'].note).toBe('15% of wall');
	});

	it('omits the row entirely when the server did not send it', () => {
		// Unauthenticated documents don't carry `cpu`, and neither does an older
		// image. An absent row beats a dash that reads as a broken measurement.
		expect(rowsOf(sources(), 'This load')['Server CPU']).toBeUndefined();
	});

	it('leaves the phase breakdown alone', () => {
		// `cpu` decomposes the same span a second way; it must not leak into the
		// note whose contract is that its parts sum to the total.
		const rows = rowsOf(
			withUsage([
				{ name: 'auth', duration: 4 },
				{ name: 'render', duration: 590 },
				{ name: 'zip', duration: 24 },
				{ name: 'cpu', duration: 90 },
			]),
			'This load',
		);
		expect(rows['Server (SSR)'].note).toBe('auth 4 ms · render 590 ms · zip 24 ms');
	});
});

/**
 * Uptime says the process wasn't freshly started; it says nothing about whether
 * the process had been sitting still. On a host that reclaims an idle
 * container's pages, that second number is the one that predicts a slow load.
 */
describe('buildDebugSections — idle before this load', () => {
	const withIdle = (entries: Array<{ name: string; duration: number }>) =>
		sources({ navigation: { ...nav, serverTiming: [{ name: 'ssr', duration: 620 }, ...entries] } });

	it('reports the gap on the same coarse scale as uptime', () => {
		const rows = rowsOf(withIdle([{ name: 'idle', duration: 8 * 3_600_000 }]), 'Environment');
		expect(rows['Idle before this load'].value).toBe('8 h');
	});

	it('does not hide a back-to-back request behind a rounding', () => {
		// Zero is a real reading — the server was serving something a moment ago,
		// so nothing had a chance to be reclaimed, and a slow load here needs a
		// different explanation entirely.
		const rows = rowsOf(withIdle([{ name: 'idle', duration: 120 }]), 'Environment');
		expect(rows['Idle before this load'].value).toBe('0 s');
	});

	it('stands alongside uptime rather than replacing it', () => {
		// The pair is the diagnostic: up for a day, idle for eight hours is a very
		// different box from up for a day and busy throughout.
		const rows = rowsOf(
			withIdle([
				{ name: 'proc', duration: 26 * 3_600_000 },
				{ name: 'idle', duration: 3 * 3_600_000 },
			]),
			'Environment',
		);
		expect(rows['Server uptime'].value).toBe('26 h');
		expect(rows['Idle before this load'].value).toBe('3 h');
	});

	it('omits the row entirely when the server did not send it', () => {
		expect(rowsOf(sources(), 'Environment')['Idle before this load']).toBeUndefined();
	});
});

/**
 * The row that makes `Server CPU` interpretable. A stall with no CPU behind it
 * is a blocking syscall, which `cpu` reports as an idle server.
 */
describe('buildDebugSections — event loop stall', () => {
	const withLag = (entries: Array<{ name: string; duration: number }>) =>
		sources({ navigation: { ...nav, serverTiming: [{ name: 'ssr', duration: 620 }, ...entries] } });

	it('reports the stall alongside the CPU share', () => {
		const rows = rowsOf(
			withLag([
				{ name: 'cpu', duration: 40 },
				{ name: 'lag', duration: 560 },
			]),
			'This load',
		);
		// The diagnostic pairing: the loop was unavailable for most of the request
		// while burning 6% of it in CPU — a blocking read, not work.
		expect(rows['Server CPU'].value).toBe('40 ms');
		expect(rows['Event loop'].value).toBe('560 ms');
	});

	it('reports a responsive loop as zero rather than hiding the row', () => {
		// Zero is the reading that clears the loop and sends you to the host, so it
		// has to be visible. An absent row would read as "not measured".
		const rows = rowsOf(withLag([{ name: 'lag', duration: 0 }]), 'This load');
		expect(rows['Event loop'].value).toBe('0 ms');
	});

	it('omits the row entirely when the server did not send it', () => {
		expect(rowsOf(sources(), 'This load')['Event loop']).toBeUndefined();
	});

	it('stands independent of the CPU row', () => {
		// An older server sending `lag` but not `cpu`, or the reverse, must not
		// take the other row down with it.
		const rows = rowsOf(withLag([{ name: 'lag', duration: 120 }]), 'This load');
		expect(rows['Event loop'].value).toBe('120 ms');
		expect(rows['Server CPU']).toBeUndefined();
	});
});

/**
 * A blank white iOS launch and a launch image iOS declined to use look
 * identical from the outside, and they are unrelated bugs with unrelated fixes.
 * This row is the only thing that separates them.
 */
describe('buildDebugSections — launch image', () => {
	it('names the device when nothing matched, so the gap can be filled', () => {
		// Zero matches means the geometry list is missing this hardware. The note
		// has to carry enough to add the row without owning the device.
		const rows = rowsOf(
			sources({ launchImage: { candidates: 88, matched: 0, device: '440x956 @3x' } }),
			'Environment',
		);
		expect(rows['Launch image'].value).toBe('no match');
		expect(rows['Launch image'].note).toBe('440x956 @3x · 88 declared');
	});

	it('reports a match, which redirects the investigation entirely', () => {
		// One match means the PNG exists and iOS had it — so adding more images
		// cannot help, and the answer is on the OS side (a restored snapshot
		// rather than a true cold launch).
		const rows = rowsOf(
			sources({ launchImage: { candidates: 88, matched: 1, device: '430x932 @3x' } }),
			'Environment',
		);
		expect(rows['Launch image'].value).toBe('matched');
	});

	it('reports zero declared rather than vanishing', () => {
		// The regression this row exists to catch: the splash block gone from
		// app.html, or gen:splash never re-run. Suppressing the row for an empty
		// list would hide exactly that.
		const rows = rowsOf(
			sources({ launchImage: { candidates: 0, matched: 0, device: '430x932 @3x' } }),
			'Environment',
		);
		expect(rows['Launch image'].value).toBe('no match');
		expect(rows['Launch image'].note).toBe('430x932 @3x · 0 declared');
	});

	it('omits the row when the question does not apply', () => {
		// Not an iOS home-screen launch — the only case that's genuinely
		// inapplicable. A "no match" here would be a true statement about an
		// irrelevant question, which is the kind of row that sends someone
		// chasing a non-bug. (Zero candidates is NOT this case; see above.)
		expect(rowsOf(sources(), 'Environment')['Launch image']).toBeUndefined();
	});
});

/**
 * The fault counter proves memory was taken back; it cannot say whether the
 * process's own footprint is growing. Read against uptime, this row separates a
 * leak in here from pressure out there.
 */
describe('buildDebugSections — server memory', () => {
	const withRss = (bytes: number, extra: Array<{ name: string; duration: number }> = []) =>
		sources({
			navigation: {
				...nav,
				serverTiming: [{ name: 'ssr', duration: 620 }, { name: 'rss', duration: bytes }, ...extra],
			},
		});

	it('reports whole mebibytes', () => {
		expect(rowsOf(withRss(268_435_456), 'Environment')['Server memory'].value).toBe('256 MB');
	});

	it('rounds rather than truncating', () => {
		// 199.6 MB reading as "199 MB" would understate a footprint right at a
		// threshold someone is watching.
		expect(rowsOf(withRss(209_300_000), 'Environment')['Server memory'].value).toBe('200 MB');
	});

	it('sits next to uptime, which is what makes it readable', () => {
		// Neither number means much alone: the question is whether the footprint
		// climbs across readings taken days apart.
		const rows = rowsOf(
			withRss(268_435_456, [{ name: 'proc', duration: 19 * 3_600_000 }]),
			'Environment',
		);
		expect(rows['Server uptime'].value).toBe('19 h');
		expect(rows['Server memory'].value).toBe('256 MB');
	});

	it('omits the row entirely when the server did not send it', () => {
		expect(rowsOf(sources(), 'Environment')['Server memory']).toBeUndefined();
	});
});
