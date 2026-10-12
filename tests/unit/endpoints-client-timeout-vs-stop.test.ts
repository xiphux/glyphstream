/**
 * A request that times out and a request the user stopped both surface as a
 * rejected fetch, but the relays treat them very differently: a Stop ends the
 * generation quietly ("Cancelled"), a timeout is a failure that must be shown
 * and persisted as an error row. The classification is by error name
 * (`isAbortError`), so the client must keep a user abort an `AbortError` and
 * must not dress a timeout up as one.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
	imageGeneration,
	chatCompletionSync,
	UpstreamError,
} from '#lib/server/endpoints/client.js';
import type { LoadedEndpoint } from '#lib/server/endpoints/config.js';
import { isAbortError } from '#lib/server/streaming/sse-transport.js';

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const endpoint = {
	id: 'ep',
	displayName: 'Ep',
	baseUrl: 'http://ep.local/v1',
	apiKey: null,
	requestTimeoutSeconds: 30,
	providerQuirk: 'passthrough',
	groupBy: 'endpoint',
	supportsTools: false,
	maxConcurrent: 4,
} as unknown as LoadedEndpoint;

/** fetch that rejects the way undici does when its signal fires. */
function rejectWith(reason: DOMException) {
	globalThis.fetch = (() => Promise.reject(reason)) as typeof fetch;
}

const calls = [
	['imageGeneration', () => imageGeneration(endpoint, { model: 'm', prompt: 'p' })],
	['chatCompletionSync', () => chatCompletionSync(endpoint, { model: 'm', messages: [] })],
] as const;

describe.each(calls)('%s', (_name, call) => {
	it('reports a timeout as a failure, not as a Stop', async () => {
		rejectWith(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
		const err = await call().catch((e: unknown) => e);
		expect(err).toBeInstanceOf(UpstreamError);
		expect(isAbortError(err)).toBe(false);
		expect((err as Error).message).toMatch(/timed out/);
	});

	it('keeps a user Stop recognisable as an abort', async () => {
		rejectWith(new DOMException('This operation was aborted', 'AbortError'));
		const err = await call().catch((e: unknown) => e);
		expect(isAbortError(err)).toBe(true);
	});
});

describe('isAbortError', () => {
	it('does not treat an error as an abort just because its message says "aborted"', () => {
		expect(
			isAbortError(
				new Error('Network error contacting endpoint: The operation was aborted due to timeout'),
			),
		).toBe(false);
		expect(
			isAbortError(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
		).toBe(false);
	});
});
