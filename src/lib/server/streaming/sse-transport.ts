/**
 * Shared SSE transport for the streaming relays (chat + image + video).
 *
 * All relays speak the same wire format — `event:`/`data:` frames of
 * StreamEvent JSON — and all must tolerate the client disconnecting
 * mid-stream while the recorder branch keeps running. Before this module
 * the two relays each carried their own copy of formatSSE, the
 * swallow-on-disconnect write, the controller.close() guard, and the
 * error-to-string chain — and they had already drifted: video-relay
 * never gained the abort detection the chat relay has. Keeping the
 * transport here means the relays can only diverge in their *logic*,
 * not their plumbing.
 */

import type { StreamEvent } from '#lib/types/api.js';
import { formatUpstreamError, UpstreamError } from '../endpoints/client';

/**
 * Serialize a StreamEvent as one SSE frame. The `event:` field lets the
 * client dispatch by type without parsing the JSON payload first.
 */
export function formatSSE(event: StreamEvent): string {
	return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Reduce any thrown value to a user-facing string. UpstreamError gets the
 * richer formatting (status code + upstream body excerpt); everything
 * else falls back to its plain message.
 */
export function errorMessage(e: unknown): string {
	if (e instanceof UpstreamError) return formatUpstreamError(e);
	if (e instanceof Error) return e.message;
	return String(e);
}

/**
 * The `error` frame's message when a media generation was stopped rather than
 * failed: a user's Stop, or a result discarded because its conversation went
 * away. Shown as-is in the column. A chat turn reports a stop differently, as
 * `done` with `finishReason: 'cancelled'`, because it keeps the partial reply.
 */
export const CANCELLED_MESSAGE = 'Cancelled';

/**
 * True when `e` is an abort — the shape thrown when the user clicks Stop
 * and the upstream fetch's AbortSignal fires. Relays treat this as "end
 * here", not as an error to surface to the user.
 *
 * By NAME only. It used to also match any message containing "aborted",
 * which a request timeout's ("The operation was aborted due to timeout")
 * does — so a timed-out generation was reported as "Cancelled" and left no
 * error row. The endpoint client keeps a real abort an `AbortError` and
 * words a timeout as one (endpoints/client.ts `wrapFetchFailure`), and the
 * relays also check their own abort signal, which covers a Stop that
 * surfaces in any other shape.
 */
export { isAbortError } from '../../abort';

/**
 * Wrap a relay's SSE body stream in a Response with the standard event-stream
 * headers — the chat / image / video dispatch paths all return the same shape.
 * `X-Accel-Buffering: no` + the no-transform cache directive defeat
 * reverse-proxy buffering (Nginx/Caddy/CloudFront) so frames flush immediately.
 */
export function sseResponse(stream: ReadableStream<Uint8Array>): Response {
	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache, no-store, no-transform',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no',
		},
	});
}

/**
 * A write/close pair bound to one ReadableStream controller, both
 * tolerant of the client having already gone away.
 */
export interface SseWriter {
	/** Enqueue a StreamEvent frame; a disconnected client is swallowed. */
	write(this: void, event: StreamEvent): void;
	/** Close the stream; closing an already-closed stream is swallowed. */
	close(this: void): void;
}

/**
 * How long consecutive deltas are gathered into one frame. One frame per
 * upstream token cost ~45 bytes of SSE framing (plus the transport's own
 * per-write overhead) around a 3-5 character chunk, uncompressed, on every
 * turn — most of what a phone downloaded while a reply streamed. 50 ms is under
 * a frame of the client's own render pump at 20 fps, so the text still arrives
 * as a smooth stream; it just arrives a few tokens at a time.
 */
export const DELTA_COALESCE_MS = 50;

/** `next` folded into `pending` when both are deltas of the same stream, else
 *  null. Text and reasoning are separate streams, as is each tool call's
 *  arguments: merging across them would reorder what the client renders. */
function mergeDelta(pending: StreamEvent, next: StreamEvent): StreamEvent | null {
	if (
		(next.type === 'text' || next.type === 'reasoning' || next.type === 'compaction_text') &&
		pending.type === next.type
	) {
		return { ...next, chunk: pending.chunk + next.chunk };
	}
	if (
		next.type === 'tool_call_args_delta' &&
		pending.type === 'tool_call_args_delta' &&
		pending.toolCallId === next.toolCallId
	) {
		return { ...next, argumentsDelta: pending.argumentsDelta + next.argumentsDelta };
	}
	return null;
}

function isDelta(event: StreamEvent): boolean {
	return (
		event.type === 'text' ||
		event.type === 'reasoning' ||
		event.type === 'compaction_text' ||
		event.type === 'tool_call_args_delta'
	);
}

/**
 * Bind SSE write/close helpers to a stream controller. The swallowing is
 * deliberate: once the browser disconnects, enqueue/close throw — but the
 * recorder branch must keep running to persist the message, so a dead
 * client is a no-op here, never an exception.
 *
 * Deltas are coalesced (see `DELTA_COALESCE_MS`): the first after a quiet spell
 * goes out at once, so the first token isn't delayed, and the ones that follow
 * inside the window are merged into a single frame. Any other event — a tool
 * call starting, `done`, an error — sends the pending delta first, so the
 * client sees exactly the sequence it would have, in fewer frames.
 */
export function sseWriter(
	controller: ReadableStreamDefaultController<Uint8Array>,
	coalesceMs = DELTA_COALESCE_MS,
): SseWriter {
	const enc = new TextEncoder();
	let pending: StreamEvent | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let lastSentAt = -Infinity;

	function send(event: StreamEvent) {
		try {
			controller.enqueue(enc.encode(formatSSE(event)));
		} catch {
			// client disconnected mid-write — recorder branch unaffected
		}
	}

	function flush() {
		if (timer) clearTimeout(timer);
		timer = null;
		if (!pending) return;
		const event = pending;
		pending = null;
		lastSentAt = Date.now();
		send(event);
	}

	return {
		write(event: StreamEvent) {
			if (!isDelta(event)) {
				flush();
				send(event);
				return;
			}
			const merged = pending && mergeDelta(pending, event);
			if (merged) {
				pending = merged;
				return;
			}
			flush();
			const wait = lastSentAt + coalesceMs - Date.now();
			if (wait <= 0) {
				lastSentAt = Date.now();
				send(event);
				return;
			}
			pending = event;
			timer = setTimeout(flush, wait);
		},
		close() {
			flush();
			try {
				controller.close();
			} catch {
				// already closed; ignore
			}
		},
	};
}
