/**
 * Route-handler tests for POST /api/conversations/[id]/avatar/generate.
 *
 * The one behaviour worth pinning here is WHERE the portrait becomes the
 * avatar. It used to happen in the browser, on `done` — which meant it happened
 * only for a draw whose client survived. iOS suspends a PWA seconds after the
 * screen locks and a draw on a shared GPU takes minutes, so the ordinary way to
 * use this feature (start it, put the phone down) was also the way to lose the
 * result: the portrait landed in the thread, the conversation kept its old
 * face, and the client showed a "Load failed" toast for a generation that had
 * succeeded. The apply now rides the relay's `onMediaPersisted`, which runs
 * server-side and doesn't care whether anyone is still listening.
 *
 * So these drive the handler with `startImageRelay` mocked, capture the params
 * it was handed, and invoke the hook the way the relay would.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAvatarDrawSince, resetInFlight } from '$lib/server/streaming/in-flight';
import type { ImageRelayParams } from '$lib/server/streaming/image-relay';

const mocks = vi.hoisted(() => ({
	getConversationMeta: vi.fn<(...a: unknown[]) => unknown>(),
	setConversationAvatar: vi.fn<(...a: unknown[]) => { ok: boolean; reason?: string }>(),
	getMessage: vi.fn<(...a: unknown[]) => unknown>(),
	getEndpoint: vi.fn<(...a: unknown[]) => unknown>(),
	listAllModels: vi.fn<(...a: unknown[]) => unknown>(),
	startImageRelay: vi.fn<(p: ImageRelayParams) => ReadableStream<Uint8Array>>(),
}));

vi.mock('$lib/server/db/queries/conversations', () => ({
	getConversationMeta: (...a: unknown[]) => mocks.getConversationMeta(...a),
	setConversationAvatar: (...a: unknown[]) => mocks.setConversationAvatar(...a),
}));
vi.mock('$lib/server/db/queries/messages', () => ({
	getMessage: (...a: unknown[]) => mocks.getMessage(...a),
}));
vi.mock('$lib/server/endpoints/registry', () => ({
	getEndpoint: (...a: unknown[]) => mocks.getEndpoint(...a),
}));
vi.mock('$lib/server/endpoints/list-models', () => ({
	listAllModels: (...a: unknown[]) => mocks.listAllModels(...a),
}));
vi.mock('$lib/server/streaming/image-relay', () => ({
	startImageRelay: (p: ImageRelayParams) => mocks.startImageRelay(p),
}));
vi.mock('$lib/server/chat/private-seal', () => ({
	resolveDisabledFeatures: () => [] as string[],
}));

import { POST } from '../../src/routes/api/conversations/[id]/avatar/generate/+server';

function call(body: Record<string, unknown> = {}) {
	const url = new URL('http://x/api/conversations/c1/avatar/generate');
	const locals = { user: { id: 'u1' } };
	const request = new Request(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			sourceMessageId: 'm1',
			modelId: 'ep::sdxl',
			prompt: 'a weathered navigator in an orange coat',
			...body,
		}),
	});
	return POST({ locals, params: { id: 'c1' }, request, url } as unknown as Parameters<
		typeof POST
	>[0]);
}

/** The params the handler passed to the relay on the most recent call. */
function relayParams(): ImageRelayParams {
	const call = mocks.startImageRelay.mock.calls.at(-1);
	if (!call) throw new Error('startImageRelay was never called');
	return call[0];
}

beforeEach(() => {
	mocks.getConversationMeta.mockReset().mockReturnValue({
		id: 'c1',
		title: 'T',
		modelId: 'ep::chat',
		modelKind: 'chat',
		endpointId: 'ep',
		activeLeafMessageId: 'm1',
		systemPrompt: null,
		private: false,
		disabledFeatures: [],
	});
	mocks.setConversationAvatar.mockReset().mockReturnValue({ ok: true });
	mocks.getMessage.mockReset().mockReturnValue({
		id: 'm1',
		role: 'assistant',
		parts: [{ type: 'text', text: 'a weathered navigator in an orange coat' }],
	});
	mocks.getEndpoint.mockReset().mockReturnValue({
		id: 'ep',
		baseUrl: 'https://example.com/v1',
		displayName: 'ep',
		apiKey: null,
		groupBy: 'endpoint',
		providerQuirk: 'passthrough',
		requestTimeoutSeconds: 30,
		maxConcurrent: Infinity,
	});
	mocks.listAllModels.mockReset().mockResolvedValue([
		{ id: 'ep::sdxl', kind: 'image', displayName: 'SDXL' },
		{ id: 'ep::chat', kind: 'chat', displayName: 'Chat' },
	]);
	mocks.startImageRelay.mockReset().mockReturnValue(new ReadableStream<Uint8Array>());
});

afterEach(() => {
	resetInFlight();
});

describe('POST /avatar/generate — applying the portrait', () => {
	it('hands the relay an onMediaPersisted that sets the conversation avatar', async () => {
		await call();
		const params = relayParams();
		expect(params.onMediaPersisted).toBeTypeOf('function');

		params.onMediaPersisted!('media-42');

		// Scoped by user id, like every other read/write of a user-owned row.
		expect(mocks.setConversationAvatar.mock.calls).toEqual([['c1', 'u1', 'media-42']]);
	});

	it('does not apply anything before the portrait exists', async () => {
		// The apply is the hook's job alone. A handler that set the avatar up front
		// (say, optimistically) would repaint the conversation for a draw that then
		// failed upstream.
		await call();
		expect(mocks.setConversationAvatar).not.toHaveBeenCalled();
	});

	it('swallows a failed apply rather than failing the generation', async () => {
		// Reachable only as a race — the conversation deleted, or the media reaped,
		// between persist and apply. The portrait is already in the thread by then,
		// so throwing here would turn a generation the user still has into an
		// `error` frame telling them they lost it.
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		mocks.setConversationAvatar.mockReturnValue({ ok: false, reason: 'not_found' });
		await call();

		expect(() => relayParams().onMediaPersisted!('media-42')).not.toThrow();
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it('registers the draw so a client whose fetch died can still see it', async () => {
		// The other half of the same failure: with the apply durable, the UI still
		// has to admit the draw is running. `getInFlightSince` deliberately hides
		// it (a draw is not a turn), so the header ring reads this instead.
		await call();
		expect(getAvatarDrawSince('c1')).not.toBeNull();
	});
});
