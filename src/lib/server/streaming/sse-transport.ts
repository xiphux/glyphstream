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
/**
 * The `error` frame's message when a media generation was stopped rather than
 * failed: a user's Stop, or a result discarded because its conversation went
 * away. Shown as-is in the column. A chat turn reports a stop differently, as
 * `done` with `finishReason: 'cancelled'`, because it keeps the partial reply.
 */
export const CANCELLED_MESSAGE = 'Cancelled';

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
 * Bind SSE write/close helpers to a stream controller. The swallowing is
 * deliberate: once the browser disconnects, enqueue/close throw — but the
 * recorder branch must keep running to persist the message, so a dead
 * client is a no-op here, never an exception.
 */
export function sseWriter(controller: ReadableStreamDefaultController<Uint8Array>): SseWriter {
	const enc = new TextEncoder();
	return {
		write(event: StreamEvent) {
			try {
				controller.enqueue(enc.encode(formatSSE(event)));
			} catch {
				// client disconnected mid-write — recorder branch unaffected
			}
		},
		close() {
			try {
				controller.close();
			} catch {
				// already closed; ignore
			}
		},
	};
}
