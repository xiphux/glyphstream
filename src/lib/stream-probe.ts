/**
 * Whether this browser, on this network, receives a gzipped stream as it is
 * written. Streaming replies are gzipped by default, flushed after every event
 * (`maybeCompressStream`), which needs everything between the server and the
 * page to pass a compressed stream through as it arrives. The operator's proxy
 * usually does, but some things on the USER's side don't — antivirus web
 * shields, corporate TLS inspection, some carriers decompress to scan and hold
 * the whole response to do it. Replies would then arrive all at once at the
 * end. No server setting can see that, and the operator would never hear of it.
 *
 * So the app checks, in the background: `STREAM_PROBE_PATH` sends two gzipped
 * events 300ms apart, and if the first doesn't arrive before the second,
 * something buffered it. The answer is kept in a cookie the server reads before
 * compressing a stream.
 *
 * And remembered, so a launch doesn't re-ask (`checkStreamCompression`). Over
 * HTTPS the networks a device moves between can't see into the stream, so they
 * can't buffer it either; what can is the deployment (its proxy) and software
 * on the device, and neither changes with the network. So the answer is kept
 * per build — a deploy, which is when a proxy changes, asks again — and for a
 * week at most, for the changes that don't come with one.
 *
 * Compression is only ever switched (back) on by a probe that watched an event
 * arrive on its own; a failed probe changes nothing. A wrong "don't compress"
 * only costs the bytes it would have saved, where a wrong "compress" costs
 * streaming itself — but it costs them for a week, so "buffered" is confirmed
 * before it's believed.
 */

import { version } from '$app/env';

export const STREAM_PROBE_PATH = '/api/stream-probe';

/** Set to `0` when this client's probe found compressed streams buffered. */
export const STREAM_GZIP_COOKIE = 'gs-stream-gzip';

/** Apart by this much at the server; the probe passes when the first event is
 *  readable before the second exists. */
export const STREAM_PROBE_GAP_MS = 300;

const PROBE_TIMEOUT_MS = 5_000;

export type StreamProbeResult =
	/** Events arrived as written: compress. */
	| 'streams'
	/** The first event waited for the second (or for the end): don't. */
	| 'buffered'
	/** Nothing learned — offline, an error, or the server isn't compressing
	 *  streams at all. Leave the last answer in place. */
	| 'unknown';

export async function probeStreamCompression(
	fetchImpl: typeof fetch = fetch,
): Promise<StreamProbeResult> {
	let res: Response;
	try {
		res = await fetchImpl(STREAM_PROBE_PATH, {
			cache: 'no-store',
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});
	} catch {
		return 'unknown';
	}
	if (!res.ok || !res.body) return 'unknown';
	// Not compressed: the server has COMPRESS_STREAMS off, or the client sent no
	// gzip — there's no compressed stream to judge.
	if (res.headers.get('content-encoding') !== 'gzip') {
		await res.body.cancel().catch(() => {});
		return 'unknown';
	}
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let text = '';
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			text += decoder.decode(value, { stream: true });
			// The first read that holds the first event decides: alone, it streamed;
			// with the second already beside it, something held it back.
			if (text.includes('"probe":1')) {
				await reader.cancel().catch(() => {});
				return text.includes('"probe":2') ? 'buffered' : 'streams';
			}
		}
	} catch (e) {
		// Only our own timeout says anything about buffering: headers came, and
		// then nothing for seconds — far past the gap. Any other failure mid-read
		// (the connection dropped, the PWA suspended, a network switch) is just a
		// failed probe.
		return e instanceof DOMException && e.name === 'TimeoutError' ? 'buffered' : 'unknown';
	}
	return 'unknown';
}

/** Record the answer for the server to read. */
export function applyStreamProbeResult(result: StreamProbeResult): void {
	if (result === 'buffered') {
		document.cookie = `${STREAM_GZIP_COOKIE}=0; path=/; max-age=2592000; samesite=lax`;
	} else if (result === 'streams') {
		document.cookie = `${STREAM_GZIP_COOKIE}=; path=/; max-age=0; samesite=lax`;
	}
}

const CACHE_KEY = 'glyphstream:streamProbe';
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Before re-asking a "buffered", so the page has finished starting up. */
const CONFIRM_DELAY_MS = 1_500;

interface CachedProbe {
	version: string;
	at: number;
	result: 'streams' | 'buffered';
}

function readCached(now: number): CachedProbe['result'] | null {
	try {
		const raw = localStorage.getItem(CACHE_KEY);
		if (!raw) return null;
		const c = JSON.parse(raw) as Partial<CachedProbe>;
		if (c.version !== version || typeof c.at !== 'number' || now - c.at > CACHE_MAX_AGE_MS) {
			return null;
		}
		return c.result === 'streams' || c.result === 'buffered' ? c.result : null;
	} catch {
		return null;
	}
}

function writeCached(result: CachedProbe['result'], now: number): void {
	try {
		const c: CachedProbe = { version, at: now, result };
		localStorage.setItem(CACHE_KEY, JSON.stringify(c));
	} catch {
		// Storage full or blocked: the next launch just probes again.
	}
}

/**
 * The launch-time entry point: the remembered answer if this build has one
 * from the last week, else a probe. A remembered answer is re-applied to the
 * cookie rather than trusted to still be there — cookies cleared without
 * storage would otherwise leave a client that buffers compressed streams
 * without its opt-out, and nothing would re-ask for a week. An `unknown` is
 * never remembered.
 */
export async function checkStreamCompression(
	fetchImpl: typeof fetch = fetch,
	now = Date.now(),
	confirmDelayMs = CONFIRM_DELAY_MS,
): Promise<void> {
	const cached = readCached(now);
	if (cached) {
		applyStreamProbeResult(cached);
		return;
	}
	let result = await probeStreamCompression(fetchImpl);
	// A "buffered" is asked twice before it's believed. Launch is when the page
	// is busiest, and a main thread held for 300ms between the response
	// arriving and the first read gets both events in one read — as does a
	// momentary stall on a mobile link. Either reads as buffering, and the
	// answer is kept for a week, so it costs that device the compression all
	// week. A second probe once the page has settled tells the two apart, and
	// costs a request only when the first one said "buffered".
	if (result === 'buffered') {
		await new Promise((r) => setTimeout(r, confirmDelayMs));
		result = await probeStreamCompression(fetchImpl);
	}
	applyStreamProbeResult(result);
	if (result !== 'unknown') writeCached(result, now);
}
