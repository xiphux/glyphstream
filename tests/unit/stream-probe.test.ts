/* @vitest-environment happy-dom */
/**
 * The launch-time check that a gzipped stream reaches this client as it's
 * written (`#lib/stream-probe.ts`). The decision rests on one observation: is
 * the first event readable before the second has been sent? Every doubt is
 * "don't compress" or "don't change anything", never "compress".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	applyStreamProbeResult,
	checkStreamCompression,
	probeStreamCompression,
	STREAM_GZIP_COOKIE,
} from '#lib/stream-probe.js';

const enc = new TextEncoder();
const ONE = 'event: probe\ndata: {"probe":1}\n\n';
const TWO = 'event: probe\ndata: {"probe":2}\n\n';

/** A probe response delivering `chunks` as separate reads, as the browser
 *  hands them to the page (already decompressed). */
function respond(chunks: string[], encoding: string | null = 'gzip'): typeof fetch {
	return () =>
		Promise.resolve(
			new Response(
				new ReadableStream<Uint8Array>({
					start(c) {
						for (const chunk of chunks) c.enqueue(enc.encode(chunk));
						c.close();
					},
				}),
				{ headers: encoding ? { 'content-encoding': encoding } : {} },
			),
		);
}

describe('probeStreamCompression', () => {
	it('passes when the first event arrives on its own', async () => {
		expect(await probeStreamCompression(respond([ONE, TWO]))).toBe('streams');
	});

	it('fails when the first event waited for the second', async () => {
		expect(await probeStreamCompression(respond([ONE + TWO]))).toBe('buffered');
	});

	it('learns nothing from an uncompressed response, or no response', async () => {
		// COMPRESS_STREAMS off on the server: no compressed stream to judge.
		expect(await probeStreamCompression(respond([ONE, TWO], null))).toBe('unknown');
		expect(await probeStreamCompression(() => Promise.reject(new TypeError('offline')))).toBe(
			'unknown',
		);
		expect(
			await probeStreamCompression(() => Promise.resolve(new Response(null, { status: 401 }))),
		).toBe('unknown');
	});

	it('treats any other failure mid-read as a failed probe, not as buffering', async () => {
		// A dropped connection or a suspended PWA says nothing about a buffer.
		const dropped: typeof fetch = () =>
			Promise.resolve(
				new Response(
					new ReadableStream({ pull: () => Promise.reject(new TypeError('network error')) }),
					{ headers: { 'content-encoding': 'gzip' } },
				),
			);
		expect(await probeStreamCompression(dropped)).toBe('unknown');
	});

	it('counts a stream that stalls before the first event as held back', async () => {
		const stalled: typeof fetch = () =>
			Promise.resolve(
				new Response(
					new ReadableStream({
						pull: () => Promise.reject(new DOMException('timed out', 'TimeoutError')),
					}),
					{ headers: { 'content-encoding': 'gzip' } },
				),
			);
		expect(await probeStreamCompression(stalled)).toBe('buffered');
	});
});

describe('applyStreamProbeResult', () => {
	afterEach(() => {
		document.cookie = `${STREAM_GZIP_COOKIE}=; path=/; max-age=0`;
	});

	it('opts this browser out on a fail, back in on a pass, and leaves it on unknown', () => {
		applyStreamProbeResult('buffered');
		expect(document.cookie).toContain(`${STREAM_GZIP_COOKIE}=0`);
		applyStreamProbeResult('unknown');
		expect(document.cookie).toContain(`${STREAM_GZIP_COOKIE}=0`);
		applyStreamProbeResult('streams');
		// Cleared (happy-dom keeps an emptied cookie where a browser drops it; the
		// server only acts on `0` either way).
		expect(document.cookie).not.toContain(`${STREAM_GZIP_COOKIE}=0`);
	});
});

describe('checkStreamCompression — the remembered answer', () => {
	const DAY = 24 * 60 * 60 * 1000;
	const optedOut = () => document.cookie.includes(`${STREAM_GZIP_COOKIE}=0`);

	beforeEach(() => {
		localStorage.clear();
		document.cookie = `${STREAM_GZIP_COOKIE}=; path=/; max-age=0`;
	});

	it('probes once, then reuses the answer for the rest of the week', async () => {
		// A "buffered" is asked twice before it is believed: two requests.
		const fetchImpl = vi.fn(respond([ONE + TWO]));
		await checkStreamCompression(fetchImpl, 0, 0);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(optedOut()).toBe(true);

		await checkStreamCompression(fetchImpl, 6 * DAY, 0);
		expect(fetchImpl).toHaveBeenCalledTimes(2);

		await checkStreamCompression(fetchImpl, 8 * DAY, 0);
		expect(fetchImpl).toHaveBeenCalledTimes(4);
	});

	it('believes the second probe when the first said buffered and it streams', async () => {
		// Launch is when the page is busiest: a main thread held past the gap
		// gets both events in one read. Once settled, the same network streams.
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockImplementationOnce(respond([ONE + TWO]))
			.mockImplementationOnce(respond([ONE, TWO]));
		await checkStreamCompression(fetchImpl, 0, 0);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(optedOut()).toBe(false);
		// And it's the pass that's remembered.
		const later = vi.fn(respond([ONE + TWO]));
		await checkStreamCompression(later, DAY, 0);
		expect(later).not.toHaveBeenCalled();
		expect(optedOut()).toBe(false);
	});

	it('puts a remembered opt-out back if the cookie was cleared', async () => {
		await checkStreamCompression(respond([ONE + TWO]), 0, 0);
		document.cookie = `${STREAM_GZIP_COOKIE}=; path=/; max-age=0`;
		const fetchImpl = vi.fn(respond([ONE, TWO]));
		await checkStreamCompression(fetchImpl, DAY, 0);
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(optedOut()).toBe(true);
	});

	it('asks again for another build', async () => {
		await checkStreamCompression(respond([ONE + TWO]), 0, 0);
		const stored = JSON.parse(localStorage.getItem('glyphstream:streamProbe')!) as object;
		localStorage.setItem(
			'glyphstream:streamProbe',
			JSON.stringify({ ...stored, version: 'an older build' }),
		);
		const fetchImpl = vi.fn(respond([ONE, TWO]));
		await checkStreamCompression(fetchImpl, DAY, 0);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(optedOut()).toBe(false);
	});

	it('never remembers an answer it could not get', async () => {
		const offline = vi.fn(() => Promise.reject(new TypeError('offline')));
		await checkStreamCompression(offline, 0);
		await checkStreamCompression(offline, 1);
		expect(offline).toHaveBeenCalledTimes(2);
	});
});
