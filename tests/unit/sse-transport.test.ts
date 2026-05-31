/** Tests for the shared SSE transport used by the streaming relays. */

import { describe, expect, it } from 'vitest';
import {
	errorMessage,
	formatSSE,
	isAbortError,
	sseWriter,
} from '$lib/server/streaming/sse-transport';
import { UpstreamError } from '$lib/server/endpoints/client';

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

	it('detects an error whose message mentions "aborted"', () => {
		expect(isAbortError(new Error('The operation was aborted'))).toBe(true);
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
