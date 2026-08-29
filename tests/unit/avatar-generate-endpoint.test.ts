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
import {
	getAvatarDrawSince,
	getInFlightSince,
	getInFlightEntries,
	registerInFlight,
	resetInFlight,
} from '$lib/server/streaming/in-flight';
import { MAX_FANOUT_BRANCHES_PER_CONVERSATION } from '$lib/fanout';
import type { LoadedEndpoint } from '$lib/server/endpoints/config';
import type { ImageRelayParams } from '$lib/server/streaming/image-relay';

const mocks = vi.hoisted(() => ({
	getConversationMeta: vi.fn<(...a: unknown[]) => unknown>(),
	setConversationAvatar: vi.fn<(...a: unknown[]) => { ok: boolean; reason?: string }>(),
	getFanoutParent: vi.fn<(...a: unknown[]) => string | null>(),
	getMessage: vi.fn<(...a: unknown[]) => unknown>(),
	getSiblingAssistants: vi.fn<(...a: unknown[]) => unknown[]>(),
	getEndpoint: vi.fn<(...a: unknown[]) => unknown>(),
	listAllModels: vi.fn<(...a: unknown[]) => unknown>(),
	startImageRelay: vi.fn<(p: ImageRelayParams) => ReadableStream<Uint8Array>>(),
	notifyFanoutCompleteIfLast: vi.fn<(...a: unknown[]) => void>(),
}));

vi.mock('$lib/server/db/queries/conversations', () => ({
	getConversationMeta: (...a: unknown[]) => mocks.getConversationMeta(...a),
	setConversationAvatar: (...a: unknown[]) => mocks.setConversationAvatar(...a),
	getFanoutParent: (...a: unknown[]) => mocks.getFanoutParent(...a),
}));
vi.mock('$lib/server/db/queries/messages', () => ({
	getMessage: (...a: unknown[]) => mocks.getMessage(...a),
	getSiblingAssistants: (...a: unknown[]) => mocks.getSiblingAssistants(...a),
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
vi.mock('$lib/server/messages/fanout-notify', () => ({
	notifyFanoutCompleteIfLast: (...a: unknown[]) => mocks.notifyFanoutCompleteIfLast(...a),
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
	mocks.notifyFanoutCompleteIfLast.mockReset();
	mocks.getFanoutParent.mockReset().mockReturnValue(null);
	mocks.getSiblingAssistants.mockReset().mockReturnValue([]);
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

describe('POST /avatar/generate — one branch of a comparison', () => {
	// The single-model draw is a background side errand and the multi-model one is
	// a parked comparison. Everything below is a consequence of that single split,
	// so each test names the consequence rather than the flag.

	it('applies nothing on arrival', async () => {
		// Three portraits racing to be the face would repaint the header at each
		// model's finishing time and settle on whichever GPU was slowest. Which one
		// wins is the user's answer, and ../pick is where they give it.
		await call({ fanout: true });
		expect(relayParams().onMediaPersisted).toBeUndefined();
	});

	it('leaves the leaf parked at the description', async () => {
		// Every branch is a sibling of the others; none wins by landing first. The
		// pick moves the leaf. (../prepare put it on the description; a branch
		// advancing it would take the grid down mid-comparison, since recovery only
		// reports a fan-out whose marker IS the leaf.)
		await call({ fanout: true });
		expect(relayParams().advanceActiveLeaf).toBe(false);
	});

	it('defers its notification to the aggregate', async () => {
		// N branches would otherwise buzz N times.
		await call({ fanout: true });
		expect(relayParams().suppressNotify).toBe(true);
	});

	it('counts as a turn, so a recovered grid can show it generating', async () => {
		// The mirror of the background draw's registration: a comparison's branches
		// ARE the grid, and `getFanoutRecoveryState` builds its placeholder columns
		// from the turn-scoped entries.
		await call({ fanout: true });
		expect(getInFlightSince('c1')).not.toBeNull();
		// …and not under the background key, so the header ring keeps meaning
		// "a draw is running with nobody watching it" and nothing else.
		expect(getAvatarDrawSince('c1')).toBeNull();
	});

	it('does not abort the branch dispatched before it', async () => {
		// The background draw takes a stable key precisely SO a second draw
		// supersedes the first. Branches of one comparison must do the opposite, or
		// a 3-model draw would leave one portrait and two aborts.
		await call({ fanout: true });
		await call({ fanout: true });
		await call({ fanout: true });
		const entries = getInFlightEntries('c1');
		expect(entries).toHaveLength(3);
		expect(entries.every((e) => !e.controller.signal.aborted)).toBe(true);
	});

	it('refuses to hang a comparison branch under a user message', async () => {
		// ../prepare vets the anchor before parking, but a branch is a separate
		// request and can arrive without one. This is the route that actually
		// creates the row, and the anchor's role is what the recovery state reports
		// its `avatar` flag from.
		mocks.getMessage.mockReturnValue({
			id: 'm1',
			role: 'user',
			parts: [{ type: 'text', text: 'draw me' }],
		});
		await expect(call({ fanout: true })).rejects.toMatchObject({ status: 400 });
	});

	it('still draws a background portrait from a user message', async () => {
		// Unchanged for the single-model path: it parks no marker and so never
		// reaches the recovery flag, and the endpoint has always been usable against
		// any message with text.
		mocks.getMessage.mockReturnValue({
			id: 'm1',
			role: 'user',
			parts: [{ type: 'text', text: 'draw me' }],
		});
		await call();
		expect(mocks.startImageRelay).toHaveBeenCalled();
	});

	it.each([
		['above the branch ceiling', 999999],
		['negative', -3],
		['fractional', 2.5],
	])('drops a fanoutSize that is %s', async (_label, size) => {
		// It rides straight into the push notification's text, so a bare
		// `typeof === 'number'` lets a hand-written body print whatever it likes
		// ("999999 images ready"). Bounded by the same cap the dispatch is.
		// (Infinity is NOT a case: JSON.stringify emits it as null, so it never
		// survives the wire — which is exactly why this uses values that do.)
		await call({ fanout: true, fanoutSize: size });
		mocks.notifyFanoutCompleteIfLast.mockClear();
		relayParams().onComplete!();
		expect(mocks.notifyFanoutCompleteIfLast.mock.calls[0][0]).toMatchObject({
			fanoutSize: undefined,
		});
	});

	it('keeps a fanoutSize the dispatch could actually have produced', async () => {
		await call({ fanout: true, fanoutSize: 3 });
		mocks.notifyFanoutCompleteIfLast.mockClear();
		relayParams().onComplete!();
		expect(mocks.notifyFanoutCompleteIfLast.mock.calls[0][0]).toMatchObject({ fanoutSize: 3 });
	});

	it('refuses a branch past the per-conversation ceiling', async () => {
		// Each branch holds an SSE connection, a registry entry and a queued waiter,
		// so the cap is a resource bound, not a UI preference — the client mirrors
		// it, and this is what makes it true.
		const endpoint = { id: 'ep' } as unknown as LoadedEndpoint;
		for (let i = 0; i < MAX_FANOUT_BRANCHES_PER_CONVERSATION; i++) {
			registerInFlight('c1', endpoint, `filler-${i}`, 'image', 'ep::sdxl', null);
		}
		await expect(call({ fanout: true })).rejects.toMatchObject({ status: 429 });
	});

	it('refuses a background draw onto an anchor a comparison is parked on', async () => {
		// The mirror of ../prepare's refusal. A parked comparison pins the leaf at
		// its anchor, which is the exact state this draw's compare-and-swap reads as
		// "safe to advance" — so it would take the leaf off the description, drop the
		// grid out of recovery, and apply a face nobody picked.
		mocks.getFanoutParent.mockReturnValue('m1');
		mocks.getSiblingAssistants.mockReturnValue([{ id: 'p1' }]);
		await expect(call()).rejects.toMatchObject({ status: 409 });
		expect(mocks.startImageRelay).not.toHaveBeenCalled();
	});

	it('refuses while a comparison is parked whose branches have not persisted yet', async () => {
		// No siblings, but branches are registered as turns — the window between
		// dispatch and the first portrait landing. Refusing here is the point of the
		// pending half of the predicate.
		mocks.getFanoutParent.mockReturnValue('m1');
		registerInFlight(
			'c1',
			{ id: 'ep' } as unknown as LoadedEndpoint,
			'branch-1',
			'image',
			'x',
			null,
		);
		await expect(call()).rejects.toMatchObject({ status: 409 });
	});

	it('draws through a marker left behind by a comparison that produced nothing', async () => {
		// Every branch can fail without persisting a row (a Stop writes `Cancelled`
		// and appends nothing), and the client then drops its grid locally without
		// telling the server. A bare marker test would 409 every later draw against
		// a comparison with no grid to dismiss — and this is the operation that
		// repairs it, since the compare-and-swap nulls the marker as it advances.
		mocks.getFanoutParent.mockReturnValue('m1');
		mocks.getSiblingAssistants.mockReturnValue([]);
		await call();
		expect(mocks.startImageRelay).toHaveBeenCalled();
	});

	it('still draws while a fan-out is parked on a different anchor', async () => {
		// Scoped to THIS anchor rather than to any parked fan-out, and the
		// distinction is load-bearing: an ordinary turn fan-out parks on a user
		// message while the avatar anchor is the last assistant reply, so the
		// compare-and-swap fails harmlessly and the draw is exactly what was asked
		// for. A broader guard would refuse it.
		mocks.getFanoutParent.mockReturnValue('some-other-message');
		await call();
		expect(mocks.startImageRelay).toHaveBeenCalled();
	});

	it('does not refuse a comparison branch on its own parked anchor', async () => {
		// The guard is for background draws only — a branch is the thing the marker
		// was parked FOR.
		mocks.getFanoutParent.mockReturnValue('m1');
		await call({ fanout: true });
		expect(mocks.startImageRelay).toHaveBeenCalled();
	});

	it('still supersedes at the background key when only one model is drawn', async () => {
		// The other half of the split, asserted here so a future change to the
		// fan-out path can't quietly take it with it.
		await call();
		await call();
		expect(getAvatarDrawSince('c1')).not.toBeNull();
		expect(getInFlightEntries('c1')).toHaveLength(1);
	});
});
