/** Tests for the shared SSE transport used by the streaming relays. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	errorMessage,
	formatSSE,
	isAbortError,
	sseWriter,
} from '#lib/server/streaming/sse-transport.js';
import { UpstreamError } from '#lib/server/endpoints/client.js';

describe('formatSSE', () => {
	it('frames an event with the event: and data: fields', () => {
		expect(formatSSE({ type: 'text', chunk: 'hi' })).toBe(
			'event: text\ndata: {"type":"text","chunk":"hi"}\n\n',
		);
	});
});

describe('errorMessage', () => {
	it('uses the rich formatting for an UpstreamError', () => {
		const e = new UpstreamError(
			'Endpoint "x" returned HTTP 500',
			500,
			JSON.stringify({ error: { message: 'boom' } }),
		);
		expect(errorMessage(e)).toBe('Endpoint "x" returned HTTP 500: boom');
	});

	it('uses .message for a plain Error', () => {
		expect(errorMessage(new Error('plain'))).toBe('plain');
	});

	it('stringifies a non-Error value', () => {
		expect(errorMessage('just a string')).toBe('just a string');
		expect(errorMessage(42)).toBe('42');
	});
});

describe('isAbortError', () => {
	it('detects a DOMException AbortError', () => {
		expect(isAbortError(new DOMException('aborted', 'AbortError'))).toBe(true);
	});

	it('detects an Error named AbortError', () => {
		const e = new Error('stop');
		e.name = 'AbortError';
		expect(isAbortError(e)).toBe(true);
	});

	it('does not match on message text — a timeout says "aborted" too', () => {
		expect(isAbortError(new Error('The operation was aborted due to timeout'))).toBe(false);
	});

	it('is false for unrelated errors and non-errors', () => {
		expect(isAbortError(new Error('network down'))).toBe(false);
		expect(isAbortError('nope')).toBe(false);
		expect(isAbortError(null)).toBe(false);
	});
});

describe('sseWriter', () => {
	it('frames and enqueues an event', () => {
		const chunks: string[] = [];
		const dec = new TextDecoder();
		const w = sseWriter({
			enqueue: (c: Uint8Array) => chunks.push(dec.decode(c)),
			close: () => {},
		} as unknown as ReadableStreamDefaultController<Uint8Array>);
		w.write({ type: 'text', chunk: 'x' });
		expect(chunks).toEqual(['event: text\ndata: {"type":"text","chunk":"x"}\n\n']);
	});

	it('swallows writes/closes to a disconnected controller', () => {
		const w = sseWriter({
			enqueue: () => {
				throw new Error('client gone');
			},
			close: () => {
				throw new Error('already closed');
			},
		} as unknown as ReadableStreamDefaultController<Uint8Array>);
		expect(() => w.write({ type: 'text', chunk: 'x' })).not.toThrow();
		expect(() => w.close()).not.toThrow();
	});
});

describe('sseWriter — delta coalescing', () => {
	/** The events the client would parse, in order. */
	function capture() {
		const frames: Array<Record<string, unknown>> = [];
		let closed = false;
		const dec = new TextDecoder();
		const w = sseWriter({
			enqueue: (c: Uint8Array) => {
				const data = /^data: (.*)$/m.exec(dec.decode(c))![1];
				frames.push(JSON.parse(data) as Record<string, unknown>);
			},
			close: () => (closed = true),
		} as unknown as ReadableStreamDefaultController<Uint8Array>);
		return { w, frames, closed: () => closed };
	}

	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('sends the first token at once, and merges the ones that follow into a frame', () => {
		const { w, frames } = capture();
		w.write({ type: 'text', chunk: 'Hel' });
		// No delay on the first token: it's the one the user is waiting for.
		expect(frames).toEqual([{ type: 'text', chunk: 'Hel' }]);
		w.write({ type: 'text', chunk: 'lo' });
		w.write({ type: 'text', chunk: ', wor' });
		w.write({ type: 'text', chunk: 'ld' });
		expect(frames).toHaveLength(1);
		vi.advanceTimersByTime(50);
		expect(frames).toEqual([
			{ type: 'text', chunk: 'Hel' },
			{ type: 'text', chunk: 'lo, world' },
		]);
	});

	it('never merges across streams, and keeps their order', () => {
		const { w, frames } = capture();
		w.write({ type: 'reasoning', chunk: 'a' });
		w.write({ type: 'reasoning', chunk: 'b' });
		w.write({ type: 'text', chunk: 'c' });
		w.write({ type: 'tool_call_args_delta', toolCallId: 't1', argumentsDelta: '{"q"' });
		w.write({ type: 'tool_call_args_delta', toolCallId: 't1', argumentsDelta: ':1}' });
		w.write({ type: 'tool_call_args_delta', toolCallId: 't2', argumentsDelta: '{}' });
		vi.advanceTimersByTime(50);
		expect(frames).toEqual([
			{ type: 'reasoning', chunk: 'a' },
			{ type: 'reasoning', chunk: 'b' },
			{ type: 'text', chunk: 'c' },
			{ type: 'tool_call_args_delta', toolCallId: 't1', argumentsDelta: '{"q":1}' },
			{ type: 'tool_call_args_delta', toolCallId: 't2', argumentsDelta: '{}' },
		]);
	});

	it('sends a pending delta before any other event, and before closing', () => {
		const { w, frames, closed } = capture();
		w.write({ type: 'text', chunk: 'a' });
		w.write({ type: 'text', chunk: 'b' });
		w.write({ type: 'title', title: 'T' });
		w.write({ type: 'text', chunk: 'c' });
		w.close();
		expect(frames).toEqual([
			{ type: 'text', chunk: 'a' },
			{ type: 'text', chunk: 'b' },
			{ type: 'title', title: 'T' },
			{ type: 'text', chunk: 'c' },
		]);
		expect(closed()).toBe(true);
		// Nothing left armed to fire after the stream is gone.
		expect(vi.getTimerCount()).toBe(0);
	});
});
