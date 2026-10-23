/** Tests for the on-the-fly gzip wrapper used when no compression-
 *  capable reverse proxy is in front. */

import { describe, expect, it } from 'vitest';
import {
	brotliDecompressSync,
	constants as zlibConstants,
	gunzipSync,
	zstdDecompressSync,
} from 'node:zlib';
import { maybeCompressResponse, maybeCompressStream } from '#lib/server/compression.js';

// Common Accept-Encoding header carried by modern browsers — Chrome 123+,
// Firefox 126+, Safari 17.4+. Used by skip-rule tests where the specific
// encoding picked doesn't matter, only the present-or-not behavior.
const ACCEPT_ALL = { 'accept-encoding': 'gzip, deflate, br, zstd' };

/** Body just big enough to trip the 1 KB threshold, with enough
 *  redundancy that the compressors actually produce smaller output. */
const BIG_BODY = 'abcdefgh '.repeat(200); // ~1.8 KB, compresses ~10x

function makeResponse(
	body: string | null,
	init: { status?: number; headers?: Record<string, string> } = {},
): Response {
	return new Response(body, {
		status: init.status ?? 200,
		headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
	});
}

function makeRequest(headers: Record<string, string> = {}, method = 'GET'): Request {
	return new Request('http://localhost/x', { method, headers });
}

describe('maybeCompressResponse — encoding selection', () => {
	it('gzips when the client advertises only gzip', async () => {
		const out = await maybeCompressResponse(
			makeResponse(BIG_BODY),
			makeRequest({ 'accept-encoding': 'gzip' }),
		);
		expect(out.headers.get('Content-Encoding')).toBe('gzip');
		expect(out.headers.get('Vary')).toContain('Accept-Encoding');

		const compressed = Buffer.from(await out.arrayBuffer());
		expect(compressed.length).toBeLessThan(BIG_BODY.length);
		expect(out.headers.get('Content-Length')).toBe(String(compressed.length));
		expect(gunzipSync(compressed).toString('utf-8')).toBe(BIG_BODY);
	});

	it('prefers brotli over gzip when both are accepted', async () => {
		const out = await maybeCompressResponse(
			makeResponse(BIG_BODY),
			// Deliberately omit zstd so the test asserts br > gz, not
			// the zstd path.
			makeRequest({ 'accept-encoding': 'gzip, br' }),
		);
		expect(out.headers.get('Content-Encoding')).toBe('br');
		const compressed = Buffer.from(await out.arrayBuffer());
		expect(brotliDecompressSync(compressed).toString('utf-8')).toBe(BIG_BODY);
	});

	it('prefers zstd over br + gz when all three are accepted', async () => {
		const out = await maybeCompressResponse(
			makeResponse(BIG_BODY),
			makeRequest({ 'accept-encoding': 'gzip, br, zstd' }),
		);
		expect(out.headers.get('Content-Encoding')).toBe('zstd');
		const compressed = Buffer.from(await out.arrayBuffer());
		expect(zstdDecompressSync(compressed).toString('utf-8')).toBe(BIG_BODY);
	});

	it('falls back to br when the client speaks br but not zstd', async () => {
		const out = await maybeCompressResponse(
			makeResponse(BIG_BODY),
			makeRequest({ 'accept-encoding': 'gzip, br' }),
		);
		expect(out.headers.get('Content-Encoding')).toBe('br');
	});

	it('falls back to gz when the client speaks neither zstd nor br', async () => {
		const out = await maybeCompressResponse(
			makeResponse(BIG_BODY),
			makeRequest({ 'accept-encoding': 'gzip, deflate' }),
		);
		expect(out.headers.get('Content-Encoding')).toBe('gzip');
	});
});

describe('maybeCompressResponse — response shape', () => {
	it('appends Accept-Encoding to an existing Vary header rather than replacing it', async () => {
		const res = makeResponse(BIG_BODY, { headers: { Vary: 'Cookie' } });
		const out = await maybeCompressResponse(res, makeRequest(ACCEPT_ALL));
		expect(out.headers.get('Vary')).toBe('Cookie, Accept-Encoding');
	});

	it('leaves an already-weak Vary alone if Accept-Encoding is already in it', async () => {
		const res = makeResponse(BIG_BODY, { headers: { Vary: 'Cookie, Accept-Encoding' } });
		const out = await maybeCompressResponse(res, makeRequest(ACCEPT_ALL));
		expect(out.headers.get('Vary')).toBe('Cookie, Accept-Encoding');
	});

	it('weakens a strong ETag (compressed bytes ≠ source bytes)', async () => {
		const res = makeResponse(BIG_BODY, { headers: { ETag: '"abc123"' } });
		const out = await maybeCompressResponse(res, makeRequest(ACCEPT_ALL));
		expect(out.headers.get('ETag')).toBe('W/"abc123"');
	});

	it('leaves a weak ETag alone', async () => {
		const res = makeResponse(BIG_BODY, { headers: { ETag: 'W/"abc123"' } });
		const out = await maybeCompressResponse(res, makeRequest(ACCEPT_ALL));
		expect(out.headers.get('ETag')).toBe('W/"abc123"');
	});

	it('handles a charset suffix on Content-Type', async () => {
		const res = new Response(BIG_BODY, {
			headers: { 'Content-Type': 'application/json; charset=utf-8' },
		});
		const out = await maybeCompressResponse(res, makeRequest({ 'accept-encoding': 'gzip' }));
		// gzip-only Accept-Encoding picks gzip regardless of the charset suffix.
		expect(out.headers.get('Content-Encoding')).toBe('gzip');
	});
});

describe('maybeCompressResponse — skip rules', () => {
	it('skips HEAD requests', async () => {
		const out = await maybeCompressResponse(
			makeResponse(BIG_BODY),
			makeRequest(ACCEPT_ALL, 'HEAD'),
		);
		expect(out.headers.get('Content-Encoding')).toBeNull();
	});

	it('skips when the client advertises no supported encoding', async () => {
		// `deflate` and `identity` aren't in our chain — neither is `compress`.
		const out = await maybeCompressResponse(
			makeResponse(BIG_BODY),
			makeRequest({ 'accept-encoding': 'compress, deflate' }),
		);
		expect(out.headers.get('Content-Encoding')).toBeNull();
	});

	it('skips when Accept-Encoding is missing entirely', async () => {
		const out = await maybeCompressResponse(makeResponse(BIG_BODY), makeRequest());
		expect(out.headers.get('Content-Encoding')).toBeNull();
	});

	it('skips when Content-Encoding is already set', async () => {
		const res = makeResponse(BIG_BODY, { headers: { 'Content-Encoding': 'br' } });
		const out = await maybeCompressResponse(res, makeRequest(ACCEPT_ALL));
		expect(out.headers.get('Content-Encoding')).toBe('br');
	});

	it('skips text/event-stream (would break SSE)', async () => {
		// SSE responses use chunked transfer + flushed events. gzip
		// buffering would coalesce them into one big delivery at the
		// end, breaking the live in-flight bubble. Critical exclusion.
		const res = new Response('event: x\ndata: hi\n\n'.repeat(100), {
			headers: { 'Content-Type': 'text/event-stream' },
		});
		const out = await maybeCompressResponse(res, makeRequest(ACCEPT_ALL));
		expect(out.headers.get('Content-Encoding')).toBeNull();
	});

	it('skips binary content (image/png)', async () => {
		const res = new Response(Buffer.alloc(2048).fill(1), {
			headers: { 'Content-Type': 'image/png' },
		});
		const out = await maybeCompressResponse(res, makeRequest(ACCEPT_ALL));
		expect(out.headers.get('Content-Encoding')).toBeNull();
	});

	it('skips 204 No Content', async () => {
		const res = new Response(null, {
			status: 204,
			headers: { 'Content-Type': 'application/json' },
		});
		const out = await maybeCompressResponse(res, makeRequest(ACCEPT_ALL));
		expect(out.headers.get('Content-Encoding')).toBeNull();
	});

	it('skips 304 Not Modified', async () => {
		const res = new Response(null, {
			status: 304,
			headers: { 'Content-Type': 'application/json' },
		});
		const out = await maybeCompressResponse(res, makeRequest(ACCEPT_ALL));
		expect(out.headers.get('Content-Encoding')).toBeNull();
	});

	it('skips 206 Partial Content (Range responses)', async () => {
		const res = new Response(BIG_BODY, {
			status: 206,
			headers: { 'Content-Type': 'application/json', 'Content-Range': 'bytes 0-1799/3600' },
		});
		const out = await maybeCompressResponse(res, makeRequest(ACCEPT_ALL));
		expect(out.headers.get('Content-Encoding')).toBeNull();
	});

	it('skips bodies under the 1 KB threshold', async () => {
		const out = await maybeCompressResponse(makeResponse('{"ok":true}'), makeRequest(ACCEPT_ALL));
		expect(out.headers.get('Content-Encoding')).toBeNull();
		// And the round-tripped body is unchanged.
		expect(await out.text()).toBe('{"ok":true}');
	});

	it('preserves the status code on the small-body path', async () => {
		const res = makeResponse('{"error":"x"}', { status: 400 });
		const out = await maybeCompressResponse(res, makeRequest(ACCEPT_ALL));
		expect(out.status).toBe(400);
	});

	it('preserves the status code on the compressed path', async () => {
		const res = makeResponse(BIG_BODY, { status: 201 });
		const out = await maybeCompressResponse(res, makeRequest(ACCEPT_ALL));
		expect(out.status).toBe(201);
	});
});

describe('compression does not block the event loop', () => {
	/**
	 * The codecs used to run through zlib's *Sync variants, which occupy the
	 * event loop for the whole compression. On this single-process server that
	 * stalls every other in-flight request — including SSE forwarding for other
	 * users' live generations. At brotli-4's ~70-100 MB/s a multi-MB conversation
	 * payload is tens of milliseconds of global stall, on exactly the deploy this
	 * feature exists for (a proxy that can't compress, i.e. the least CPU
	 * headroom).
	 *
	 * Asserted by observing that timers keep firing while a large body is being
	 * compressed: with the sync codecs the loop is pinned and the counter cannot
	 * advance until after the response resolves.
	 */
	it('lets other tasks run while a large body compresses', async () => {
		// Compressible but not trivially so, and big enough to take real time.
		const body = Array.from({ length: 200_000 }, (_, i) => `line ${i} of the payload\n`).join('');
		const res = new Response(body, { headers: { 'Content-Type': 'application/json' } });
		const req = new Request('http://localhost/api/big', {
			headers: { 'accept-encoding': 'br' },
		});

		let ticks = 0;
		const tick = () => {
			ticks++;
			timer = setTimeout(tick, 0);
		};
		let timer = setTimeout(tick, 0);

		const out = await maybeCompressResponse(res, req);
		clearTimeout(timer);

		expect(out.headers.get('Content-Encoding')).toBe('br');
		expect(ticks, 'event loop was blocked for the whole compression').toBeGreaterThan(0);
	});
});

describe('maybeCompressStream', () => {
	/** An SSE response whose frames the test writes one at a time. */
	function sse() {
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			start: (c) => {
				controller = c;
			},
			cancel: () => {
				cancelled = true;
			},
		});
		const response = new Response(body, {
			headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-transform' },
		});
		const enc = new TextEncoder();
		return {
			response,
			write: (frame: string) => controller.enqueue(enc.encode(frame)),
			end: () => controller.close(),
			cancelled: () => cancelled,
		};
	}

	const req = (headers: Record<string, string> = ACCEPT_ALL) =>
		new Request('http://x/api/conversations/c/messages', { headers });

	it('delivers each frame decodable as soon as it is written, not at the end', async () => {
		const s = sse();
		const out = maybeCompressStream(s.response, req());
		expect(out.headers.get('Content-Encoding')).toBe('gzip');
		expect(out.headers.get('Vary')).toBe('Accept-Encoding');

		// Decode what has arrived so far, the way a browser does as bytes land:
		// a sync-flushed gzip prefix decodes on its own, trailer or not.
		const reader = out.body!.getReader();
		const received: Uint8Array[] = [];
		const decoded = () =>
			gunzipSync(Buffer.concat(received), {
				finishFlush: zlibConstants.Z_SYNC_FLUSH,
			}).toString();
		const readUntil = async (expected: string) => {
			while (!decoded().includes(expected)) {
				const { value, done } = await reader.read();
				if (done) throw new Error(`stream ended before ${expected}`);
				received.push(value);
			}
		};

		s.write('event: text\ndata: {"type":"text","chunk":"one"}\n\n');
		await readUntil('"one"');
		// The second frame isn't written yet: the first arrived on its own.
		expect(decoded()).not.toContain('"two"');
		s.write('event: text\ndata: {"type":"text","chunk":"two"}\n\n');
		await readUntil('"two"');
		s.end();
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			received.push(value);
		}
		// And the finished stream is a complete, valid gzip body.
		expect(gunzipSync(Buffer.concat(received)).toString()).toBe(
			'event: text\ndata: {"type":"text","chunk":"one"}\n\n' +
				'event: text\ndata: {"type":"text","chunk":"two"}\n\n',
		);
	});

	it('cancels the source stream when the client goes away', async () => {
		const s = sse();
		const out = maybeCompressStream(s.response, req());
		s.write('event: text\ndata: {}\n\n');
		await out.body!.cancel();
		await new Promise((r) => setTimeout(r, 10));
		expect(s.cancelled()).toBe(true);
	});

	it('leaves alone a client without gzip, and anything that is not a stream', () => {
		const a = sse();
		expect(maybeCompressStream(a.response, req({ 'accept-encoding': 'br' }))).toBe(a.response);
		const json = makeResponse(BIG_BODY, { headers: { 'Content-Type': 'application/json' } });
		expect(maybeCompressStream(json, req())).toBe(json);
	});
});
