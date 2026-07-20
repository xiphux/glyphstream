/**
 * chatCompletionStream arms an idle watchdog: an upstream that returns 200 then
 * goes silent must have its fetch aborted (so the endpoint concurrency slot is
 * released), while a stream that keeps producing bytes within the idle window
 * flows through untouched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatCompletionStream } from '$lib/server/endpoints/client';
import type { LoadedEndpoint } from '$lib/server/endpoints/config';

function endpoint(requestTimeoutSeconds: number): LoadedEndpoint {
	return {
		id: 'e1',
		baseUrl: 'http://backend.local:8080/v1',
		apiKey: null,
		requestTimeoutSeconds,
	} as unknown as LoadedEndpoint;
}

const realFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	vi.useFakeTimers();
	fetchMock = vi.fn();
	globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
	vi.useRealTimers();
	globalThis.fetch = realFetch;
	vi.restoreAllMocks();
});

/** Build a Response whose body is driven by an async producer, and which
 *  aborts (errors the stream) when `init.signal` fires — mirroring fetch. */
function streamingResponse(
	produce: (push: (s: string) => void, close: () => void) => void,
	signal: AbortSignal,
): Response {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			const enc = new TextEncoder();
			const push = (s: string) => controller.enqueue(enc.encode(s));
			const close = () => controller.close();
			signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
			produce(push, close);
		},
	});
	return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function drain(res: Response): Promise<string> {
	const reader = res.body!.getReader();
	const dec = new TextDecoder();
	let out = '';
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value) out += dec.decode(value, { stream: true });
	}
	return out;
}

describe('chatCompletionStream idle watchdog', () => {
	it('aborts the read when the upstream stalls past the idle deadline', async () => {
		fetchMock.mockImplementation((_url, init: RequestInit) =>
			// Push one chunk, then go silent forever.
			Promise.resolve(streamingResponse((push) => push('data: hi\n\n'), init.signal!)),
		);

		const res = await chatCompletionStream(endpoint(30), {
			model: 'm',
			messages: [],
		} as never);

		// Attach the rejection handler up front so there's no unhandled-rejection
		// window while fake timers advance.
		const assertion = expect(drain(res)).rejects.toMatchObject({ name: 'TimeoutError' });
		// Within the window: first chunk delivered, no abort yet.
		await vi.advanceTimersByTimeAsync(29_000);
		// Cross the 30s idle deadline with no further data → watchdog aborts.
		await vi.advanceTimersByTimeAsync(2_000);
		await assertion;
	});

	it('passes bytes through untouched when data keeps arriving', async () => {
		fetchMock.mockImplementation((_url, init: RequestInit) =>
			Promise.resolve(
				streamingResponse((push, close) => {
					push('a');
					// Second chunk well within the 30s window, then clean close.
					setTimeout(() => {
						push('b');
						close();
					}, 5_000);
				}, init.signal!),
			),
		);

		const res = await chatCompletionStream(endpoint(30), {
			model: 'm',
			messages: [],
		} as never);

		const drained = drain(res);
		await vi.advanceTimersByTimeAsync(6_000);
		expect(await drained).toBe('ab');
	});

	it('does NOT abort during a slow prefill (no bytes before the first token)', async () => {
		// A long time-to-first-token (large-context prefill on a cold local model)
		// must not trip the watchdog — it only guards mid-stream stalls.
		fetchMock.mockImplementation((_url, init: RequestInit) =>
			Promise.resolve(
				streamingResponse((push, close) => {
					// First byte arrives only after 90s — well past the 30s idle window.
					setTimeout(() => {
						push('first token');
						close();
					}, 90_000);
				}, init.signal!),
			),
		);

		const res = await chatCompletionStream(endpoint(30), {
			model: 'm',
			messages: [],
		} as never);

		const drained = drain(res);
		await vi.advanceTimersByTimeAsync(95_000);
		// Prefill was not aborted; the token came through.
		expect(await drained).toBe('first token');
	});
});
