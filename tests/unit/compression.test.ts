/** Tests for the on-the-fly gzip wrapper used when no compression-
 *  capable reverse proxy is in front. */

import { describe, expect, it } from 'vitest';
import { brotliDecompressSync, gunzipSync, zstdDecompressSync } from 'node:zlib';
import { maybeCompressResponse } from '$lib/server/compression';

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
