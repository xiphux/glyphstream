import { requireUser } from '#lib/server/auth/guard.js';
import { sseResponse } from '#lib/server/streaming/sse-transport.js';
import { STREAM_PROBE_GAP_MS } from '#lib/stream-probe.js';
import type { RequestHandler } from './$types';

/**
 * Two events, `STREAM_PROBE_GAP_MS` apart — the client's check that a gzipped
 * stream reaches it as it's written (see `#lib/stream-probe.ts`). Always
 * compressed when the client accepts gzip, whatever its probe last found: the
 * hook ignores the opt-out cookie for this path, or a client that once failed
 * could never pass again.
 */
export const GET: RequestHandler = ({ locals }) => {
	requireUser(locals);
	const enc = new TextEncoder();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(enc.encode('event: probe\ndata: {"probe":1}\n\n'));
			timer = setTimeout(() => {
				try {
					controller.enqueue(enc.encode('event: probe\ndata: {"probe":2}\n\n'));
					controller.close();
				} catch {
					// The client has its answer and went away.
				}
			}, STREAM_PROBE_GAP_MS);
		},
		cancel() {
			clearTimeout(timer);
		},
	});
	return sseResponse(stream);
};
