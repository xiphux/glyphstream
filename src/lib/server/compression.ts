/**
 * On-the-fly compression for dynamic responses.
 *
 * Only used when the deploy has no compression-capable reverse proxy in
 * front (Synology's built-in proxy is the canonical case — it doesn't
 * expose a compress option in the UI). Static assets are precompressed
 * at build time by adapter-node, so this only fires on SSR pages and
 * API responses.
 *
 * Gated by the COMPRESS_DYNAMIC env var; default off. When a proxy IS
 * doing dynamic compression, leaving this off avoids the proxy
 * re-compressing what we already encoded (proxies typically skip
 * already-encoded responses, but the round trip still costs CPU on the
 * app side for no net gain).
 *
 * Critical exclusion: text/event-stream MUST NOT be gzip-buffered. The
 * chat page relies on each SSE event reaching the browser at flush
 * time; gzip's default buffering coalesces events and turns the
 * streaming UI into a single end-of-stream delivery.
 */

import {
	brotliCompressSync,
	constants as zlibConstants,
	gzipSync,
	zstdCompressSync,
} from 'node:zlib';

/**
 * Below this size, gzip framing overhead and the cost of breaking the
 * client's etag-cache approach the savings. 1 KB is a common default
 * (Express compression uses 1 KB; nginx uses 20).
 */
const MIN_COMPRESS_BYTES = 1024;

/**
 * Levels chosen to favor SPEED over the last few percent of ratio.
 * Each codec's slow-mode is unsuitable per-request:
 *  - gzip 6 is Node's default (~50-80 MB/s, ~3× ratio on text).
 *  - brotli 4 is a "fast preset" (~70-100 MB/s, ~3.4× ratio); brotli
 *    11 (the precompress default) is 5-10× slower.
 *  - zstd 3 is the library default (~400-500 MB/s, ~3.2× ratio).
 *    Faster than both gzip and brotli at fast presets, which is why
 *    we prefer it when the client supports it.
 */
const GZIP_LEVEL = 6;
const BROTLI_LEVEL = 4;
const ZSTD_LEVEL = 3;

/**
 * Content-types whose body bytes are worth compressing. SSE is
 * deliberately absent (see the file header). Binary types (images,
 * video, audio, pdf, octet-stream) are already compressed at the
 * format level and gzip would just add overhead.
 */
const COMPRESSIBLE_TYPES = new Set([
	'text/html',
	'text/css',
	'text/plain',
	'text/javascript',
	'text/xml',
	'application/json',
	'application/javascript',
	'application/xml',
	'application/manifest+json',
	'image/svg+xml',
]);

function isCompressibleType(contentType: string | null): boolean {
	if (!contentType) return false;
	const type = contentType.split(';')[0].trim().toLowerCase();
	return COMPRESSIBLE_TYPES.has(type);
}

type Encoding = 'zstd' | 'br' | 'gzip';

/**
 * Pick the best supported encoding in priority order: zstd > br > gzip.
 * The priority is anchored to browser availability — modern browsers
 * (Chrome/Edge 123+, Firefox 126+, Safari 17.4+, all 2024+) advertise
 * all three; older ones drop zstd first, then brotli. zstd at level 3
 * is faster than both br-4 and gzip-6 with a similar/better ratio, so
 * the priority improves both bandwidth AND CPU as clients update.
 *
 * Permissive token match — Accept-Encoding can carry q-values
 * (`gzip;q=1, br;q=0.8`) but a present token-with-non-zero implicit
 * value is the common case. A client that wants to refuse a codec
 * sends `;q=0` after the token, which we don't currently honor — the
 * cost would be a `text/plain` parser and the only realistic use is
 * curl's `--no-keepalive` style debugging.
 */
function pickEncoding(acceptEncoding: string | null): Encoding | null {
	if (!acceptEncoding) return null;
	if (/\bzstd\b/i.test(acceptEncoding)) return 'zstd';
	if (/\bbr\b/i.test(acceptEncoding)) return 'br';
	if (/\bgzip\b/i.test(acceptEncoding)) return 'gzip';
	return null;
}

function compress(data: Buffer, encoding: Encoding): Buffer {
	switch (encoding) {
		case 'zstd':
			return zstdCompressSync(data, {
				params: { [zlibConstants.ZSTD_c_compressionLevel]: ZSTD_LEVEL },
			});
		case 'br':
			return brotliCompressSync(data, {
				params: {
					[zlibConstants.BROTLI_PARAM_QUALITY]: BROTLI_LEVEL,
					// Hint that the payload is text — lets brotli use its
					// text-tuned dictionary.
					[zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
				},
			});
		case 'gzip':
			return gzipSync(data, { level: GZIP_LEVEL });
	}
}

/**
 * Wrap a Response with on-the-fly compression if the response is a
 * worthwhile candidate and the client advertises support. Returns the
 * original response untouched if any skip-rule matches.
 *
 * Skip rules (any one applies):
 *   - HEAD requests (no body to compress)
 *   - Response already carries a Content-Encoding (e.g. proxied
 *     pre-compressed bytes, or a future code path that compresses
 *     ahead of this hook)
 *   - Response has no body
 *   - Status is 204 / 304 / 206 (no body / not-modified / partial)
 *   - Content-Type is not in the compressible-types allowlist (binary
 *     formats are already compressed at the format level, SSE must
 *     not be buffered — see header)
 *   - Client advertises none of zstd / br / gzip
 *   - Buffered body is under the minimum-size threshold
 */
export async function maybeCompressResponse(
	response: Response,
	request: Request,
): Promise<Response> {
	if (request.method === 'HEAD') return response;
	if (response.headers.get('Content-Encoding')) return response;
	if (!response.body) return response;
	if (response.status === 204 || response.status === 304 || response.status === 206) {
		return response;
	}
	if (!isCompressibleType(response.headers.get('Content-Type'))) return response;
	const encoding = pickEncoding(request.headers.get('accept-encoding'));
	if (!encoding) return response;

	// Buffer the body. SSE was excluded above (text/event-stream isn't
	// in COMPRESSIBLE_TYPES), so this can't stall a streaming response.
	const raw = Buffer.from(await response.arrayBuffer());
	// Node's `Buffer.buffer` is typed as `ArrayBuffer | SharedArrayBuffer`,
	// but Node-allocated buffers are always backed by ArrayBuffer. The
	// `.slice()` call returns the same kind as its receiver, so the
	// assertion is safe.
	const toArrayBuffer = (buf: Buffer): ArrayBuffer =>
		buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;

	if (raw.length < MIN_COMPRESS_BYTES) {
		// Reconstitute — arrayBuffer() consumed the original body.
		return new Response(toArrayBuffer(raw), {
			status: response.status,
			headers: response.headers,
		});
	}

	const compressed = compress(raw, encoding);

	const headers = new Headers(response.headers);
	headers.set('Content-Encoding', encoding);
	headers.set('Content-Length', String(compressed.length));
	// Vary signals to caches that the bytes depend on Accept-Encoding —
	// without it, a caching proxy could serve a gzip body to a client
	// that asked for identity.
	const vary = headers.get('Vary');
	if (!vary) headers.set('Vary', 'Accept-Encoding');
	else if (!/accept-encoding/i.test(vary)) {
		headers.set('Vary', `${vary}, Accept-Encoding`);
	}
	// Strong ETag no longer matches the bytes on the wire. Mark weak so
	// conditional GETs still work without false-positive 304s.
	const etag = headers.get('ETag');
	if (etag && !etag.startsWith('W/')) headers.set('ETag', `W/${etag}`);

	return new Response(toArrayBuffer(compressed), {
		status: response.status,
		headers,
	});
}
