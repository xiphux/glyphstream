/**
 * cancelInFlightGenerations — the Stop button and conversation delete.
 *
 * The ordering is the contract: every local abort lands synchronously, before
 * any bridge-side video cancel is awaited. Conversation delete fires this
 * without awaiting it, so if a video branch's best-effort DELETE (up to a 10s
 * timeout) came first, that branch — and a chat branch queued behind it in the
 * same fan-out — would keep streaming and holding its endpoint slot for a
 * conversation that no longer exists.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	videoCancel: vi.fn((): Promise<void> => new Promise(() => {})),
}));
vi.mock('$lib/server/endpoints/client', () => ({ videoCancel: mocks.videoCancel }));

import { cancelInFlightGenerations } from '$lib/server/streaming/cancel';
import { registerInFlight, resetInFlight } from '$lib/server/streaming/in-flight';
import type { LoadedEndpoint } from '$lib/server/endpoints/config';

const endpoint: LoadedEndpoint = {
	id: 'bridge',
	displayName: 'Bridge',
	baseUrl: 'http://localhost/v1',
	apiKey: null,
	requestTimeoutSeconds: 120,
	providerQuirk: 'passthrough',
	groupBy: 'endpoint',
	supportsTools: false,
	maxConcurrent: Infinity,
	resourceGroup: 'bridge',
	resourceGroupMaxConcurrent: Infinity,
	release: null,
	contextWindow: null,
	modelContextWindows: {},
	modelPromptStyles: {},
	modelPromptHints: {},
};

afterEach(() => {
	resetInFlight();
	mocks.videoCancel.mockClear();
});

describe('cancelInFlightGenerations', () => {
	it('resolves false with nothing in flight', async () => {
		await expect(cancelInFlightGenerations('nothing-here')).resolves.toBe(false);
	});

	it('aborts every branch synchronously, before a hung bridge cancel resolves', () => {
		const video = registerInFlight('c1', endpoint, 'video-branch', 'video');
		video.videoJobId = 'job-1';
		const chat = registerInFlight('c1', endpoint, 'chat-branch', 'chat');

		// Not awaited, exactly like conversation delete; videoCancel never settles.
		void cancelInFlightGenerations('c1');

		expect(video.controller.signal.aborted).toBe(true);
		expect(chat.controller.signal.aborted).toBe(true);
		expect(mocks.videoCancel).toHaveBeenCalledExactlyOnceWith(endpoint, 'job-1');
	});

	it('resolves once the bridge cancels settle', async () => {
		mocks.videoCancel.mockResolvedValueOnce(undefined);
		const video = registerInFlight('c2', endpoint, 'video-branch', 'video');
		video.videoJobId = 'job-2';
		await expect(cancelInFlightGenerations('c2')).resolves.toBe(true);
	});
});
