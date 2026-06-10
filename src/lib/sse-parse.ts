/**
 * Single SSE (Server-Sent Events) wire-format parser, shared by the server's
 * upstream relay and the browser's stream reader. Both consume a
 * `ReadableStream<Uint8Array>` and get one `{ event, data }` record per SSE
 * block (records separated by blank lines per the spec; multi-line `data:` is
 * concatenated with newlines).
 *
 * Wraps `eventsource-parser` — the spec-complete, dependency-free, isomorphic
 * parser that underpins the major LLM SDKs — so we no longer maintain two
 * hand-rolled copies. Two deliberate deviations from the bare library preserve
 * the behavior our consumers were built against:
 *
 *   1. `event` defaults to `"message"` when a block omits an `event:` line.
 *      The library leaves it `undefined`; our client dispatches by event name
 *      and the server's normalizers expect the EventSource default.
 *   2. A block that never receives its terminating blank line is still emitted
 *      at end-of-stream — some upstreams close the socket right after the last
 *      delta. The library (correctly, per spec) drops it; we force the dispatch
 *      by feeding a final blank line, which is a no-op when nothing is pending.
 *
 * The un-dispatched buffer is capped via `maxBufferSize`: a misbehaving
 * upstream that never sends a separator throws `SSEBufferOverflowError` rather
 * than growing `buffer += …` until the process OOMs. 8 MiB is ~two orders of
 * magnitude past any legitimate single SSE block and still leaves room for a
 * multi-MB error body before it trips.
 *
 * id/retry fields are intentionally ignored — these are request-scoped streams
 * we never reconnect.
 */
import { createParser } from 'eventsource-parser';

export interface SSERecord {
	event: string;
	data: string;
}

const MAX_SSE_BUFFER_BYTES = 8 * 1024 * 1024;

export class SSEBufferOverflowError extends Error {
	constructor(public readonly bufferBytes: number) {
		super(
			`SSE buffer exceeded ${MAX_SSE_BUFFER_BYTES} bytes without a block separator (saw ${bufferBytes} bytes). Aborting to avoid OOM.`,
		);
		this.name = 'SSEBufferOverflowError';
	}
}

export async function* parseSSEStream(
	stream: ReadableStream<Uint8Array>,
): AsyncIterable<SSERecord> {
	const reader = stream.getReader();
	const decoder = new TextDecoder('utf-8');

	const pending: SSERecord[] = [];
	let overflow: SSEBufferOverflowError | null = null;

	const parser = createParser({
		onEvent(event) {
			pending.push({ event: event.event ?? 'message', data: event.data });
		},
		onError(err) {
			// Only the buffer cap is fatal. unknown-field / invalid-retry are
			// non-fatal: the field is ignored, exactly as the prior parser did.
			if (err.type === 'max-buffer-size-exceeded') {
				overflow = new SSEBufferOverflowError(MAX_SSE_BUFFER_BYTES);
			}
		},
		maxBufferSize: MAX_SSE_BUFFER_BYTES,
	});

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				// Flush a final block that never got its terminating blank line.
				// Feeding one dispatches it; a no-op when nothing is pending.
				if (!overflow) parser.feed('\n\n');
				yield* drain(pending);
				if (overflow) throw overflow;
				return;
			}

			parser.feed(decoder.decode(value, { stream: true }));
			// Surface whatever parsed cleanly before the overflow, then abort.
			yield* drain(pending);
			if (overflow) throw overflow;
		}
	} finally {
		reader.releaseLock();
	}
}

/** Yield and clear the buffered records the parser pushed during a feed. */
function* drain(buf: SSERecord[]): Generator<SSERecord> {
	while (buf.length > 0) yield buf.shift()!;
}
