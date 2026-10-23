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
 * So the app checks, in the background, once per launch: `STREAM_PROBE_PATH`
 * sends two gzipped events 300ms apart, and if the first doesn't arrive before
 * the second, something buffered it. The answer is kept in a cookie the server
 * reads before compressing a stream; a launch that passes clears it again, so
 * moving off the network that buffered restores compression.
 *
 * Every doubt resolves to "don't compress": that only costs the bytes it would
 * have saved, where a wrong "compress" costs streaming itself.
 */

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
	} catch {
		// Timed out mid-stream: far past the gap, so the stream was held.
		return 'buffered';
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
