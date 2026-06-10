/**
 * Tests for the browser-side SSE reader (`readSSE`). This is the mirror of
 * the server's `parseSSEStream`: it consumes our OWN outbound stream
 * (`event: <type>\ndata: <json>\n\n`), so faithful `event:` parsing matters
 * more here than upstream — `consumeChatStream` dispatches by event name.
 *
 * The two parsers are intentionally near-identical wire-format readers; this
 * suite locks the client's behavior independently so a shared-parser
 * refactor can't silently regress one side.
 */

import { describe, expect, it } from 'vitest';
import { readSSE, type SSEEventRecord } from '$lib/sse-client';

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

async function collect(stream: ReadableStream<Uint8Array>): Promise<SSEEventRecord[]> {
	const out: SSEEventRecord[] = [];
	for await (const r of readSSE(stream)) out.push(r);
	return out;
}

describe('readSSE — block parsing', () => {
	it('parses a single data block delimited by a blank line', async () => {
		expect(await collect(streamFrom('data: hello\n\n'))).toEqual([
			{ event: 'message', data: 'hello' },
		]);
	});

	it('defaults event to "message" when none is provided', async () => {
		const records = await collect(streamFrom('data: x\n\n'));
		expect(records[0].event).toBe('message');
	});

	it('honors an explicit event: field (the outbound typed-event shape)', async () => {
		const records = await collect(streamFrom('event: token\ndata: {"text":"hi"}\n\n'));
		expect(records[0]).toEqual({ event: 'token', data: '{"text":"hi"}' });
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

	it('drops blocks with no data lines (event-only)', async () => {
		const records = await collect(streamFrom('event: ping\n\ndata: real\n\n'));
		expect(records).toEqual([{ event: 'message', data: 'real' }]);
	});

	it('ignores comment lines (starting with ":")', async () => {
		const records = await collect(streamFrom(': keep-alive\ndata: x\n\n'));
		expect(records[0].data).toBe('x');
	});

	it('ignores id: and retry: fields', async () => {
		const records = await collect(streamFrom('id: 42\nretry: 5000\ndata: ping\n\n'));
		expect(records).toEqual([{ event: 'message', data: 'ping' }]);
	});
});

describe('readSSE — line endings', () => {
	it('accepts CRLF block separators (\\r\\n\\r\\n)', async () => {
		const records = await collect(streamFrom('data: hello\r\n\r\n'));
		expect(records[0].data).toBe('hello');
	});

	it('handles mixed LF/CRLF within a single stream', async () => {
		const records = await collect(streamFrom('data: lf\n\ndata: crlf\r\n\r\n'));
		expect(records.map((r) => r.data)).toEqual(['lf', 'crlf']);
	});
});

describe('readSSE — chunk boundaries', () => {
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
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes.slice(0, 8)); // "data: " + 0xF0 0x9F
				controller.enqueue(bytes.slice(8)); // 0x9A 0x80 + "\n\n"
				controller.close();
			},
		});
		const records = await collect(stream);
		expect(records[0].data).toBe('🚀');
	});

	it('parses many small chunks (one byte at a time)', async () => {
		const records = await collect(streamFrom([...'data: hi\n\n']));
		expect(records[0].data).toBe('hi');
	});
});

describe('readSSE — end-of-stream', () => {
	it('emits a trailing block missing its blank-line terminator', async () => {
		// Some servers/proxies close without the final \n\n; deliver the last block.
		const records = await collect(streamFrom('data: last\n'));
		expect(records[0].data).toBe('last');
	});

	it('emits nothing on an empty stream', async () => {
		expect(await collect(streamFrom(''))).toEqual([]);
	});

	it('emits nothing for a whitespace-only trailing buffer', async () => {
		// Client trims the residual buffer on done — pure whitespace yields nothing.
		expect(await collect(streamFrom('   \n  '))).toEqual([]);
	});

	it('releases the reader lock so the stream can be inspected after iteration', async () => {
		const stream = streamFrom('data: x\n\n');
		await collect(stream);
		expect(() => stream.getReader()).not.toThrow();
	});
});

describe('readSSE — outbound typed-event stream (our own shape)', () => {
	it('parses a token/usage/done sequence by event name', async () => {
		const stream = streamFrom(
			[
				'event: token\ndata: {"text":"Hello"}\n\n',
				'event: token\ndata: {"text":" world"}\n\n',
				'event: done\ndata: {"id":"abc"}\n\n',
			].join(''),
		);
		const records = await collect(stream);
		expect(records.map((r) => r.event)).toEqual(['token', 'token', 'done']);
		expect(records[2].data).toBe('{"id":"abc"}');
	});
});
