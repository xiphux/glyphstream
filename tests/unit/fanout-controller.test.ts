/**
 * Unit tests for the extracted multi-model fan-out controller. Instantiated
 * with mock deps + a URL-dispatching fetch stub, so the orchestration (server
 * recovery rebuild, the derived grid state, the pick/discard/stop/send flows)
 * is exercised without a live page or backend. $app/navigation + the title
 * spinner are module-mocked; the controller itself runs its real runes (the
 * sveltekit() vitest plugin compiles the .svelte.ts module).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const invalidateAll = vi.fn(async () => {});
vi.mock('$app/navigation', () => ({ invalidateAll: () => invalidateAll() }));
vi.mock('$lib/title-pending.svelte', () => ({
	markTitlePending: vi.fn(),
	clearTitlePending: vi.fn(),
}));

import { FanoutController, type FanoutDeps } from '$lib/fanout-controller.svelte';
import { expandFanoutBranches, MAX_FANOUT_BRANCHES_PER_CONVERSATION } from '$lib/fanout';
import type { ChatMessage, FanoutRecoveryState, ModelEntry } from '$lib/types/api';

const MODELS = [
	{ id: 'bridge::sdxl', displayName: 'SDXL', kind: 'image' },
	{ id: 'bridge::claude', displayName: 'Claude', kind: 'chat' },
] as unknown as ModelEntry[];

function makeDeps(overrides: Partial<FanoutDeps> = {}) {
	const state = {
		convId: 'c1',
		busy: false,
		error: null as string | null,
		activeModel: null as { id: string; kind: string } | null,
		streamedId: null as string | null,
		interrupted: false,
		appended: [] as ChatMessage[],
	};
	const deps: FanoutDeps = {
		convId: () => state.convId,
		models: () => MODELS,
		messageCount: () => state.appended.length,
		busy: () => state.busy,
		appendUserMessage: (m) => state.appended.push(m),
		setBusy: (b) => (state.busy = b),
		setError: (m) => (state.error = m),
		setActiveModel: (id, kind) => (state.activeModel = { id, kind }),
		setStreamedMessageId: (id) => (state.streamedId = id),
		interrupted: () => state.interrupted,
		clearInterruptedFlags: () => (state.interrupted = false),
		scrollToBottom: () => {},
		...overrides,
	};
	return { deps, state };
}

/** An assistant image sibling whose output media has `sourceMediaId` (the split
 *  input) surfaced on the ChatMessage by getSiblingAssistants. */
function imageSibling(id: string, modelUsed: string, sourceMediaId: string | null): ChatMessage {
	return mediaSibling(id, modelUsed, sourceMediaId, [{ type: 'image', mediaId: `${id}-out` }]);
}

/** A persisted assistant sibling carrying arbitrary parts (image / video /
 *  error), as getSiblingAssistants would hand it to recovery. */
function mediaSibling(
	id: string,
	modelUsed: string,
	sourceMediaId: string | null,
	parts: ChatMessage['parts'],
): ChatMessage {
	return {
		id,
		role: 'assistant',
		parts,
		contentHtml: null,
		reasoningText: null,
		finishReason: null,
		modelUsed,
		tokensIn: null,
		tokensOut: null,
		genMs: null,
		createdAt: 1,
		sourceMediaId,
	};
}

describe('FanoutController — server recovery', () => {
	it('rebuilds the grid from server truth: done siblings + pending placeholders', () => {
		const { deps } = makeDeps();
		const fc = new FanoutController(deps);
		const server: FanoutRecoveryState = {
			parentMessageId: 'u1',
			kind: 'image',
			siblings: [imageSibling('a', 'bridge::sdxl', 'src-1')],
			pending: 2,
			pendingModelIds: ['bridge::sdxl', 'bridge::claude'],
			// Both branches have acquired their slot (server always reports start
			// times) → "streaming" placeholders with timers, labelled by model.
			pendingStartedAt: [2000, 3000],
		};
		fc.syncFromServer(server);

		expect(fc.userMessageId).toBe('u1');
		expect(fc.columns).toHaveLength(3); // 1 done + 2 generating
		expect(fc.columns[0]).toMatchObject({
			persisted: server.siblings[0],
			status: 'done',
			inputMediaId: 'src-1',
			modelKind: 'image',
			label: 'SDXL',
		});
		// Pending placeholders are labelled by their model (header reads like the
		// live grid), not a bare "Generating…", and carry that model's kind.
		expect(fc.columns[1]).toMatchObject({ status: 'streaming', label: 'SDXL', modelKind: 'image' });
		expect(fc.columns[2]).toMatchObject({ label: 'Claude', modelKind: 'chat' });
		expect(fc.isMedia).toBe(true);
		expect(fc.hasRecoveredPending).toBe(true);
	});

	it('restores per-branch QUEUED vs generating-timer state on recovery', () => {
		const { deps } = makeDeps();
		const fc = new FanoutController(deps);
		fc.syncFromServer({
			parentMessageId: 'u1',
			kind: 'image',
			siblings: [],
			pending: 2,
			pendingModelIds: ['bridge::sdxl', 'bridge::claude'],
			pendingStartedAt: [1000, null], // first acquired its slot, second waiting
		});
		const [generating, queued] = fc.columns;
		expect(generating).toMatchObject({ status: 'streaming', startedAt: 1000, label: 'SDXL' });
		expect(queued).toMatchObject({ status: 'queued', startedAt: null, label: 'Claude' });
	});

	it('does not clobber a live in-session fan-out', () => {
		const { deps } = makeDeps();
		const fc = new FanoutController(deps);
		fc.live = true;
		fc.syncFromServer({
			parentMessageId: 'u1',
			kind: 'image',
			siblings: [],
			pending: 3,
			pendingModelIds: ['', '', ''],
			pendingStartedAt: [1000, 1000, 1000],
		});
		expect(fc.columns).toHaveLength(0);
		expect(fc.hasRecoveredPending).toBe(false); // gated on !live
	});

	it('drops the recovered grid when the server no longer has a parked fan-out', () => {
		const { deps } = makeDeps();
		const fc = new FanoutController(deps);
		fc.syncFromServer({
			parentMessageId: 'u1',
			kind: 'image',
			siblings: [imageSibling('a', 'bridge::sdxl', null)],
			pending: 0,
			pendingModelIds: [],
			pendingStartedAt: [],
		});
		expect(fc.columns).toHaveLength(1);
		// Marker cleared server-side (pick/dismiss elsewhere) → grid clears.
		fc.syncFromServer({
			parentMessageId: null,
			kind: null,
			siblings: [],
			pending: 0,
			pendingModelIds: [],
			pendingStartedAt: [],
		});
		expect(fc.columns).toHaveLength(0);
		expect(fc.userMessageId).toBeNull();
	});

	it('rebuilds a failed branch (error sibling) as a settled error column', () => {
		const { deps } = makeDeps();
		const fc = new FanoutController(deps);
		// One branch persisted a video, the other failed (error sibling). Both must
		// surface — the failed one as an error column, not silently dropped.
		fc.syncFromServer({
			parentMessageId: 'u1',
			kind: null, // both branches settled → no in-flight kind reported
			siblings: [
				mediaSibling('ok', 'bridge::sora', null, [{ type: 'video', mediaId: 'ok-out' }]),
				mediaSibling('bad', 'bridge::sora', null, [{ type: 'error', message: 'render crashed' }]),
			],
			pending: 0,
			pendingModelIds: [],
			pendingStartedAt: [],
		});
		expect(fc.columns).toHaveLength(2);
		expect(fc.columns[0]).toMatchObject({
			status: 'done',
			modelKind: 'video',
			persisted: { id: 'ok' },
		});
		expect(fc.columns[1]).toMatchObject({
			status: 'error',
			error: 'render crashed',
			// Discardable server-side: it carries its persisted row.
			persisted: { id: 'bad' },
		});
		// The grid has no still-generating placeholders, so the recovery poll stops.
		expect(fc.hasRecoveredPending).toBe(false);
	});

	it('derives a recovered column kind from the persisted media when the model id no longer resolves', () => {
		const { deps } = makeDeps();
		const fc = new FanoutController(deps);
		// 'bridge::sora' isn't in MODELS (endpoint dropped from config / renamed),
		// but the persisted video part is ground truth — the column must render as
		// video, not fall back to a blank chat strip.
		fc.syncFromServer({
			parentMessageId: 'u1',
			kind: null,
			siblings: [mediaSibling('v', 'bridge::sora', null, [{ type: 'video', mediaId: 'v-out' }])],
			pending: 0,
			pendingModelIds: [],
			pendingStartedAt: [],
		});
		expect(fc.columns[0]).toMatchObject({ status: 'done', modelKind: 'video' });
		expect(fc.isMedia).toBe(true);
	});
});

describe('FanoutController — derived grid state', () => {
	it('comparing / streaming / settled / isMedia reflect the columns', () => {
		const { deps } = makeDeps();
		const fc = new FanoutController(deps);
		expect(fc.comparing).toBe(false);

		fc.syncFromServer({
			parentMessageId: 'u1',
			kind: 'image',
			siblings: [imageSibling('a', 'bridge::sdxl', 's')],
			pending: 1,
			pendingModelIds: [''],
			pendingStartedAt: [1000],
		});
		expect(fc.comparing).toBe(true);
		expect(fc.streaming).toBe(true); // the pending placeholder
		expect(fc.columnsSettled).toBe(false);

		// All settled (no pending) → settled true, streaming false.
		fc.syncFromServer({
			parentMessageId: 'u1',
			kind: 'image',
			siblings: [imageSibling('a', 'bridge::sdxl', 's')],
			pending: 0,
			pendingModelIds: [],
			pendingStartedAt: [],
		});
		expect(fc.streaming).toBe(false);
		expect(fc.columnsSettled).toBe(true);
	});
});

describe('FanoutController — teardown + handoff', () => {
	it('teardown clears the grid + live flag', () => {
		const { deps } = makeDeps();
		const fc = new FanoutController(deps);
		fc.syncFromServer({
			parentMessageId: 'u1',
			kind: 'image',
			siblings: [],
			pending: 2,
			pendingModelIds: ['', ''],
			pendingStartedAt: [1000, 1000],
		});
		fc.live = true;
		fc.teardown();
		expect(fc.columns).toHaveLength(0);
		expect(fc.userMessageId).toBeNull();
		expect(fc.live).toBe(false);
	});

	it('handoffToRecovery clears live + the interrupted flags', () => {
		const { deps, state } = makeDeps();
		state.interrupted = true;
		const fc = new FanoutController(deps);
		fc.live = true;
		fc.handoffToRecovery();
		expect(fc.live).toBe(false);
		expect(state.interrupted).toBe(false);
		// No-op when not live.
		state.interrupted = true;
		fc.handoffToRecovery();
		expect(state.interrupted).toBe(true);
	});
});

describe('FanoutController — actions', () => {
	beforeEach(() => {
		invalidateAll.mockClear();
	});

	function jsonResponse(body: unknown): Response {
		return { ok: true, json: async () => body } as unknown as Response;
	}

	/** A streamed (SSE) response — `data: {json}\n\n` per event, as readSSE parses. */
	function sseResponse(events: unknown[]): Response {
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				const enc = new TextEncoder();
				for (const e of events) controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
				controller.close();
			},
		});
		return { ok: true, body } as unknown as Response;
	}

	it('discard deletes the branch + removes the column, clearing handles when empty', async () => {
		const fetchMock = vi.fn(async () => jsonResponse({}));
		vi.stubGlobal('fetch', fetchMock);
		const { deps } = makeDeps();
		const fc = new FanoutController(deps);
		fc.syncFromServer({
			parentMessageId: 'u1',
			kind: 'image',
			siblings: [imageSibling('a', 'bridge::sdxl', 's1'), imageSibling('b', 'bridge::sdxl', 's2')],
			pending: 0,
			pendingModelIds: [],
			pendingStartedAt: [],
		});
		await fc.discard(fc.columns[0]);
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/conversations/c1/messages/a/branch',
			expect.objectContaining({ method: 'DELETE' }),
		);
		expect(fc.columns.map((c) => c.branchId)).toEqual(['b']);

		await fc.discard(fc.columns[0]);
		expect(fc.columns).toHaveLength(0);
		expect(fc.userMessageId).toBeNull();
		vi.unstubAllGlobals();
	});

	it('hands the fan-out off to recovery when a branch stream dies to a suspend', async () => {
		const user = imageSibling('u1', '', null);
		user.role = 'user';
		// interrupted() true models "the page was hidden/offline during the fetch";
		// the branch stream then drops (a TypeError, not an abort).
		const fetchMock = vi.fn(async (url: string) => {
			if (url.endsWith('/messages/prepare')) return jsonResponse({ userMessage: user });
			throw new TypeError('Load failed');
		});
		vi.stubGlobal('fetch', fetchMock);
		const { deps, state } = makeDeps();
		state.interrupted = true;
		const fc = new FanoutController(deps);
		await fc.send(
			'cartoon',
			[],
			[
				{ modelId: 'bridge::sdxl', modelKind: 'image', displayName: 'SDXL', inputMediaId: null },
				{ modelId: 'bridge::sdxl', modelKind: 'image', displayName: 'SDXL', inputMediaId: null },
			],
		);
		// Live grid handed off to server-truth recovery (not shown as "Failed"),
		// so the recovery flow can rebuild it.
		expect(fc.live).toBe(false);
		expect(fc.columns.every((c) => c.status !== 'error')).toBe(true);
		vi.unstubAllGlobals();
	});

	it('drops an interrupted re-roll on a parked grid (no dangling "Generating…")', async () => {
		// A re-roll whose stream dies to a suspend/offline drop on an already-parked
		// (non-live) grid must NOT park at 'streaming' — there's no in-grid control
		// to clear a non-settled column, so it would dangle until the next return
		// invalidate. It's dropped instead; server-truth recovery re-adds it.
		const fetchMock = vi.fn(async (url: string) => {
			if (url.includes('?stream=1')) throw new TypeError('Load failed');
			return jsonResponse({});
		});
		vi.stubGlobal('fetch', fetchMock);
		const { deps, state } = makeDeps();
		state.interrupted = true;
		const fc = new FanoutController(deps);
		fc.syncFromServer({
			parentMessageId: 'u1',
			kind: 'image',
			siblings: [imageSibling('a', 'bridge::sdxl', null), imageSibling('b', 'bridge::sdxl', null)],
			pending: 0,
			pendingModelIds: [],
			pendingStartedAt: [],
		});
		expect(fc.live).toBe(false);
		await fc.regenerate(fc.columns[0]);
		// Back to the original settled grid — the interrupted re-roll column is gone.
		expect(fc.columns.map((c) => c.branchId)).toEqual(['a', 'b']);
		expect(fc.columns.every((c) => c.status === 'done')).toBe(true);
		vi.unstubAllGlobals();
	});

	it('regenerate adds a new sibling beside the source, flagged as an additive re-roll', async () => {
		let branchBody: { reroll?: unknown; replacesMessageId?: unknown } = {};
		const fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
			if (url.includes('?stream=1')) {
				branchBody = JSON.parse(init?.body ?? '{}');
				return sseResponse([
					{ type: 'start', userMessage: imageSibling('u1', '', null), assistantMessageId: '' },
					{ type: 'done', assistantMessage: imageSibling('new', 'bridge::sdxl', null) },
				]);
			}
			return jsonResponse({});
		});
		vi.stubGlobal('fetch', fetchMock);
		const { deps } = makeDeps();
		const fc = new FanoutController(deps);
		fc.syncFromServer({
			parentMessageId: 'u1',
			kind: 'image',
			siblings: [imageSibling('old', 'bridge::sdxl', null)],
			pending: 0,
			pendingModelIds: [],
			pendingStartedAt: [],
		});
		await fc.regenerate(fc.columns[0]);
		// Flagged as a re-roll (keeps its own notify), and NOT a destructive replace.
		expect(branchBody.reroll).toBe(true);
		expect(branchBody).not.toHaveProperty('replacesMessageId');
		// Additive: the original survives, the re-roll lands right after it.
		expect(fc.columns.map((c) => c.persisted?.id)).toEqual(['old', 'new']);
		vi.unstubAllGlobals();
	});

	it('an additive re-roll keeps the grid unlocked + the source column untouched', async () => {
		// Hold the re-roll's branch stream open so we can inspect grid state while
		// it's in flight — guards both the additive insert and the no-grid-lock
		// behavior (regenerating one variation must not disable the others).
		let releaseStream!: () => void;
		const fetchMock = vi.fn(async (url: string) => {
			if (url.includes('?stream=1')) {
				const body = new ReadableStream<Uint8Array>({
					start(controller) {
						const enc = new TextEncoder();
						releaseStream = () => {
							controller.enqueue(
								enc.encode(
									`data: ${JSON.stringify({ type: 'done', assistantMessage: imageSibling('new-a', 'bridge::sdxl', null) })}\n\n`,
								),
							);
							controller.close();
						};
					},
				});
				return { ok: true, body } as unknown as Response;
			}
			return jsonResponse({});
		});
		vi.stubGlobal('fetch', fetchMock);
		const { deps } = makeDeps();
		const fc = new FanoutController(deps);
		fc.syncFromServer({
			parentMessageId: 'u1',
			kind: 'image',
			siblings: [imageSibling('a', 'bridge::sdxl', null), imageSibling('b', 'bridge::sdxl', null)],
			pending: 0,
			pendingModelIds: [],
			pendingStartedAt: [],
		});

		const reroll = fc.regenerate(fc.columns[0]);
		// Insertion is synchronous: a fresh column lands right after its source 'a',
		// with no grid-wide lock and the existing columns left settled + actionable.
		expect(fc.picking).toBe(false);
		expect(fc.columns.map((c) => c.persisted?.id)).toEqual(['a', undefined, 'b']);
		expect(fc.columns.map((c) => c.status)).toEqual(['done', 'queued', 'done']);

		// Let the branch fetch begin reading its stream, then complete it.
		await new Promise((r) => setTimeout(r, 0));
		releaseStream();
		await reroll;
		expect(fc.columns.map((c) => c.persisted?.id)).toEqual(['a', 'new-a', 'b']);
		expect(fc.columns.map((c) => c.status)).toEqual(['done', 'done', 'done']);
		expect(fc.picking).toBe(false);
		vi.unstubAllGlobals();
	});

	it('refuses an oversized fan-out without dispatching (mirrors the server cap)', async () => {
		const fetchMock = vi.fn(async () => jsonResponse({}));
		vi.stubGlobal('fetch', fetchMock);
		const { deps, state } = makeDeps();
		const fc = new FanoutController(deps);
		const branches = Array.from({ length: MAX_FANOUT_BRANCHES_PER_CONVERSATION + 1 }, () => ({
			modelId: 'bridge::sdxl',
			modelKind: 'image' as const,
			displayName: 'SDXL',
			inputMediaId: null,
		}));
		await fc.send('x', [], branches);
		// Bailed before even creating the shared user message — no network at all.
		expect(fetchMock).not.toHaveBeenCalled();
		expect(state.error).toContain('Too many variations');
		expect(fc.live).toBe(false);
		vi.unstubAllGlobals();
	});

	it('dispatches branches in selection order, holding each until the prior reaches the gate', async () => {
		const user = imageSibling('u1', '', null);
		user.role = 'user';
		// Each branch stream withholds its first event until we release it, so we
		// can observe that branch i+1's POST is not sent until branch i has reached
		// the gate (emitted its first SSE event) — the ordering guarantee.
		const postedModels: string[] = [];
		const releases: Array<() => void> = [];
		const fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
			if (url.endsWith('/messages/prepare')) return jsonResponse({ userMessage: user });
			const body = JSON.parse(init?.body ?? '{}') as { modelId: string };
			postedModels.push(body.modelId);
			let release!: () => void;
			const held = new Promise<void>((r) => (release = r));
			releases.push(release);
			const stream = new ReadableStream<Uint8Array>({
				async start(controller) {
					const enc = new TextEncoder();
					await held; // hold the first event until released
					controller.enqueue(
						enc.encode(
							`data: ${JSON.stringify({ type: 'start', userMessage: user, assistantMessageId: '' })}\n\n`,
						),
					);
					controller.enqueue(
						enc.encode(
							`data: ${JSON.stringify({ type: 'done', assistantMessage: imageSibling('r', 'bridge::a', null) })}\n\n`,
						),
					);
					controller.close();
				},
			});
			return { ok: true, body: stream } as unknown as Response;
		});
		vi.stubGlobal('fetch', fetchMock);
		const { deps } = makeDeps();
		const fc = new FanoutController(deps);
		const done = fc.send(
			'hi',
			[],
			[
				{ modelId: 'bridge::a', modelKind: 'chat', displayName: 'A', inputMediaId: null },
				{ modelId: 'bridge::b', modelKind: 'chat', displayName: 'B', inputMediaId: null },
				{ modelId: 'bridge::c', modelKind: 'chat', displayName: 'C', inputMediaId: null },
			],
		);

		// Only the first branch is dispatched; the rest wait for it to reach the gate.
		await vi.waitFor(() => expect(postedModels).toEqual(['bridge::a']));
		releases[0]();
		await vi.waitFor(() => expect(postedModels).toEqual(['bridge::a', 'bridge::b']));
		releases[1]();
		await vi.waitFor(() => expect(postedModels).toEqual(['bridge::a', 'bridge::b', 'bridge::c']));
		releases[2]();
		await done;
		// Columns stay in selection order throughout.
		expect(fc.columns.map((c) => c.modelId)).toEqual(['bridge::a', 'bridge::b', 'bridge::c']);
		vi.unstubAllGlobals();
	});

	it('stop posts cancel for the conversation', async () => {
		const fetchMock = vi.fn(async () => jsonResponse({}));
		vi.stubGlobal('fetch', fetchMock);
		const { deps } = makeDeps();
		const fc = new FanoutController(deps);
		await fc.stop();
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/conversations/c1/cancel',
			expect.objectContaining({ method: 'POST' }),
		);
		vi.unstubAllGlobals();
	});

	it('send (image branches): prepares the user message then streams the grid', async () => {
		const user = imageSibling('u1', '', null);
		user.role = 'user';
		// Image branches now stream over SSE (the relay emits start → done), like
		// chat/video — so each branch surfaces its queued/start state.
		const fetchMock = vi.fn(async (url: string) => {
			if (url.endsWith('/messages/prepare')) return jsonResponse({ userMessage: user });
			return sseResponse([
				{ type: 'start', userMessage: user, assistantMessageId: '' },
				{
					type: 'done',
					assistantMessage: imageSibling(
						`r${fetchMock.mock.calls.length}`,
						'bridge::sdxl',
						'img-x',
					),
				},
			]);
		});
		vi.stubGlobal('fetch', fetchMock);
		const { deps, state } = makeDeps();
		const fc = new FanoutController(deps);
		await fc.send(
			'cartoon',
			['img-1', 'img-2'],
			[
				{ modelId: 'bridge::sdxl', modelKind: 'image', displayName: 'SDXL', inputMediaId: 'img-1' },
				{ modelId: 'bridge::sdxl', modelKind: 'image', displayName: 'SDXL', inputMediaId: 'img-2' },
			],
		);
		// Branches POST with ?stream=1 now (no sync image path).
		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining('/messages?stream=1'),
			expect.anything(),
		);
		// Shared user message appended; two image columns landed (keep-many → grid stays).
		expect(state.appended).toHaveLength(1);
		expect(fc.columns).toHaveLength(2);
		expect(fc.columns.every((c) => c.status === 'done')).toBe(true);
		expect(fc.isMedia).toBe(true);
		expect(fc.live).toBe(true);
		vi.unstubAllGlobals();
	});

	it('split fan-out: cross-product dispatches one branch per (image × model), each with its own input', async () => {
		const user = imageSibling('u1', '', null);
		user.role = 'user';
		const bodies: Array<{ modelId?: string; inputMediaIds?: string[] }> = [];
		const fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
			if (url.endsWith('/messages/prepare')) return jsonResponse({ userMessage: user });
			bodies.push(JSON.parse(init?.body ?? '{}'));
			return sseResponse([
				{ type: 'start', userMessage: user, assistantMessageId: '' },
				{ type: 'done', assistantMessage: imageSibling(`r${bodies.length}`, 'bridge::sdxl', 'x') },
			]);
		});
		vi.stubGlobal('fetch', fetchMock);
		const { deps } = makeDeps();
		const fc = new FanoutController(deps);

		// Mirror the page seam: split toggle → ready image ids → cross-product.
		const branches = expandFanoutBranches(
			[
				{ modelId: 'bridge::sdxl', modelKind: 'image', displayName: 'SDXL' },
				{ modelId: 'bridge::flux', modelKind: 'image', displayName: 'Flux' },
			],
			['img-1', 'img-2'],
		);
		expect(branches).toHaveLength(4); // 2 images × 2 models
		await fc.send('cartoon', ['img-1', 'img-2'], branches);

		// One branch POST per spec, image-outer/model-inner, each carrying ONLY
		// its own split image — the provenance that drives the per-image grid.
		// fanoutSize (= branch count) rides on every branch for the aggregate notify.
		expect(bodies).toEqual([
			{
				fanoutBranch: true,
				parentMessageId: 'u1',
				modelId: 'bridge::sdxl',
				modelKind: 'image',
				inputMediaIds: ['img-1'],
				fanoutSize: 4,
			},
			{
				fanoutBranch: true,
				parentMessageId: 'u1',
				modelId: 'bridge::flux',
				modelKind: 'image',
				inputMediaIds: ['img-1'],
				fanoutSize: 4,
			},
			{
				fanoutBranch: true,
				parentMessageId: 'u1',
				modelId: 'bridge::sdxl',
				modelKind: 'image',
				inputMediaIds: ['img-2'],
				fanoutSize: 4,
			},
			{
				fanoutBranch: true,
				parentMessageId: 'u1',
				modelId: 'bridge::flux',
				modelKind: 'image',
				inputMediaIds: ['img-2'],
				fanoutSize: 4,
			},
		]);
		vi.unstubAllGlobals();
	});
});
