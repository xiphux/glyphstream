/**
 * Tests for the minimal SSE wire-format parser. We don't reconnect on
 * disconnect (it's a request-scoped stream), so id/retry are ignored —
 * but we DO need to handle multi-line data, both line endings (LF/LF
 * and CRLF/CRLF block separators), UTF-8 split across chunks, comments,
 * the [DONE] sentinel, and `event:` typed blocks.
 *
 * The parser is the bottom of the streaming stack — a subtle
 * chunk-boundary bug here would silently break every conversation.
 */

import { describe, expect, it } from 'vitest';
import {
	parseSSEStream,
	SSEBufferOverflowError,
	type SSERecord,
} from '$lib/server/streaming/sse-parser';

const MAX_SSE_BUFFER_BYTES = 8 * 1024 * 1024;

/** Wrap a string (or array of pre-split chunks) as a ReadableStream<Uint8Array>. */
function streamFrom(input: string | string[]): ReadableStream<Uint8Array> {
	const chunks = (Array.isArray(input) ? input : [input]).map((s) => new TextEncoder().encode(s));
	let i = 0;
	return new ReadableStream({
		pull(controller) {
			if (i < chunks.length) {
				controller.enqueue(chunks[i++]);
			} else {
				controller.close();
			}
		},
	});
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<SSERecord[]> {
	const out: SSERecord[] = [];
	for await (const r of parseSSEStream(stream)) out.push(r);
	return out;
}

describe('parseSSEStream — block parsing', () => {
	it('parses a single data block delimited by a blank line', async () => {
		const records = await collect(streamFrom('data: hello\n\n'));
		expect(records).toEqual([{ event: 'message', data: 'hello' }]);
	});

	it('defaults event to "message" when none is provided', async () => {
		const records = await collect(streamFrom('data: x\n\n'));
		expect(records[0].event).toBe('message');
	});

	it('honors an explicit event: field', async () => {
		const records = await collect(streamFrom('event: custom\ndata: x\n\n'));
		expect(records[0]).toEqual({ event: 'custom', data: 'x' });
	});

	it('parses two consecutive blocks', async () => {
		const records = await collect(streamFrom('data: one\n\ndata: two\n\n'));
		expect(records.map((r) => r.data)).toEqual(['one', 'two']);
	});

	it('concatenates multi-line data with newlines (RFC behavior)', async () => {
		const records = await collect(streamFrom('data: line1\ndata: line2\n\n'));
		expect(records[0].data).toBe('line1\nline2');
	});

	it('strips exactly one leading space per RFC ("data:  x" → " x")', async () => {
		const records = await collect(streamFrom('data:  hello\n\n'));
		expect(records[0].data).toBe(' hello');
	});

	it('handles a data field with no colon ("data" → "")', async () => {
		const records = await collect(streamFrom('data\n\n'));
		expect(records[0].data).toBe('');
	});

	it('drops blocks with no data lines (event-only, comments)', async () => {
		// Block with only an event line yields nothing — we have nothing to deliver.
		const records = await collect(streamFrom('event: ping\n\ndata: real\n\n'));
		expect(records).toEqual([{ event: 'message', data: 'real' }]);
	});

	it('ignores comment lines (starting with ":")', async () => {
		const records = await collect(streamFrom(': keep-alive\ndata: x\n\n'));
		expect(records[0].data).toBe('x');
	});

	it('ignores id: and retry: fields (we do not reconnect)', async () => {
		const records = await collect(streamFrom('id: 42\nretry: 5000\ndata: ping\n\n'));
		expect(records).toEqual([{ event: 'message', data: 'ping' }]);
	});
});

describe('parseSSEStream — line endings', () => {
	it('accepts CRLF block separators (\\r\\n\\r\\n)', async () => {
		const records = await collect(streamFrom('data: hello\r\n\r\n'));
		expect(records[0].data).toBe('hello');
	});

	it('handles mixed LF/CRLF within a single stream', async () => {
		const records = await collect(streamFrom('data: lf\n\ndata: crlf\r\n\r\n'));
		expect(records.map((r) => r.data)).toEqual(['lf', 'crlf']);
	});
});

describe('parseSSEStream — chunk boundaries', () => {
	it('handles a block split across multiple chunks', async () => {
		const records = await collect(streamFrom(['data: hel', 'lo\n\n']));
		expect(records[0].data).toBe('hello');
	});

	it('handles a block separator split across chunks', async () => {
		const records = await collect(streamFrom(['data: x\n', '\n']));
		expect(records[0].data).toBe('x');
	});

	it('reassembles multi-byte UTF-8 split across chunks', async () => {
		// "🚀" is 0xF0 0x9F 0x9A 0x80 (4 bytes). Split mid-codepoint.
		const bytes = new TextEncoder().encode('data: 🚀\n\n');
		const first = bytes.slice(0, 8); // "data: " + 0xF0 0x9F
		const second = bytes.slice(8); // 0x9A 0x80 + "\n\n"
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(first);
				controller.enqueue(second);
				controller.close();
			},
		});
		const records = await collect(stream);
		expect(records[0].data).toBe('🚀');
	});

	it('parses many small chunks (one byte at a time)', async () => {
		const payload = 'data: hi\n\n';
		const chunks = [...payload].map((c) => c);
		const records = await collect(streamFrom(chunks));
		expect(records[0].data).toBe('hi');
	});
});

describe('parseSSEStream — end-of-stream', () => {
	it('emits a trailing block missing its blank-line terminator', async () => {
		// Some upstreams close the connection without sending the final \n\n.
		// We still want to deliver the last block on `done: true`.
		const records = await collect(streamFrom('data: last\n'));
		expect(records[0].data).toBe('last');
	});

	it('emits nothing on an empty stream', async () => {
		const records = await collect(streamFrom(''));
		expect(records).toEqual([]);
	});

	it('releases the reader lock so the stream can be inspected after iteration', async () => {
		const stream = streamFrom('data: x\n\n');
		await collect(stream);
		// If the lock weren't released, calling .getReader() again would throw
		// "ReadableStream is locked".
		expect(() => stream.getReader()).not.toThrow();
	});
});

describe('parseSSEStream — OpenAI-shaped payloads', () => {
	it('parses a typical chat-completion delta stream', async () => {
		const stream = streamFrom(
			[
				'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
				'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
				'data: [DONE]\n\n',
			].join(''),
		);
		const records = await collect(stream);
		expect(records.length).toBe(3);
		expect(records[2].data).toBe('[DONE]');
	});
});

describe('parseSSEStream — buffer overflow guard', () => {
	it('throws SSEBufferOverflowError when a single block exceeds the cap with no separator', async () => {
		// A misbehaving upstream that never emits a block separator would grow
		// `buffer` unbounded; the cap aborts before OOM.
		const oversized = 'data: ' + 'x'.repeat(MAX_SSE_BUFFER_BYTES + 1);
		await expect(collect(streamFrom(oversized))).rejects.toThrow(SSEBufferOverflowError);
	});

	it('does NOT throw for a large payload that stays under the cap and terminates', async () => {
		// Just under the cap, properly terminated — must parse, not trip the guard.
		const big = 'x'.repeat(MAX_SSE_BUFFER_BYTES - 1024);
		const records = await collect(streamFrom(`data: ${big}\n\n`));
		expect(records[0].data).toBe(big);
	});

	it('does NOT trip across many well-separated blocks (buffer drains each block)', async () => {
		// Cumulative bytes far exceed the cap, but no single pending block does —
		// the guard measures the un-dispatched buffer, not the lifetime total.
		const block = 'data: ' + 'y'.repeat(1024) + '\n\n';
		const chunks = Array.from({ length: 16 * 1024 }, () => block); // ~16 MiB total
		const records = await collect(streamFrom(chunks));
		expect(records.length).toBe(16 * 1024);
		expect(records[0].data.length).toBe(1024);
	});
});
