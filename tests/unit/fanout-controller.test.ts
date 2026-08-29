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
import {
	expandFanoutBranches,
	MAX_FANOUT_BRANCHES_PER_CONVERSATION,
	type FanoutModel,
} from '$lib/fanout';
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
			avatar: false,
			kind: 'image',
			siblings: [imageSibling('a', 'bridge::sdxl', 'src-1')],
			pending: 2,
			pendingModelIds: ['bridge::sdxl', 'bridge::claude'],
			// Both branches have acquired their slot (server always reports start
			// times) → "streaming" placeholders with timers, labelled by model.
			pendingStartedAt: [2000, 3000],
			pendingSourceMediaIds: [null, null],
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
			avatar: false,
			kind: 'image',
			siblings: [],
			pending: 2,
			pendingModelIds: ['bridge::sdxl', 'bridge::claude'],
			pendingStartedAt: [1000, null], // first acquired its slot, second waiting
			pendingSourceMediaIds: [null, null],
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
			avatar: false,
			kind: 'image',
			siblings: [],
			pending: 3,
			pendingModelIds: ['', '', ''],
			pendingStartedAt: [1000, 1000, 1000],
			pendingSourceMediaIds: [null, null, null],
		});
		expect(fc.columns).toHaveLength(0);
		expect(fc.hasRecoveredPending).toBe(false); // gated on !live
	});

	it('drops the recovered grid when the server no longer has a parked fan-out', () => {
		const { deps } = makeDeps();
		const fc = new FanoutController(deps);
		fc.syncFromServer({
			parentMessageId: 'u1',
			avatar: false,
			kind: 'image',
			siblings: [imageSibling('a', 'bridge::sdxl', null)],
			pending: 0,
			pendingModelIds: [],
			pendingStartedAt: [],
			pendingSourceMediaIds: [],
		});
		expect(fc.columns).toHaveLength(1);
		// Marker cleared server-side (pick/dismiss elsewhere) → grid clears.
		fc.syncFromServer({
			parentMessageId: null,
			avatar: false,
			kind: null,
			siblings: [],
			pending: 0,
			pendingModelIds: [],
			pendingStartedAt: [],
			pendingSourceMediaIds: [],
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
			avatar: false,
			kind: null, // both branches settled → no in-flight kind reported
			siblings: [
				mediaSibling('ok', 'bridge::sora', null, [{ type: 'video', mediaId: 'ok-out' }]),
				mediaSibling('bad', 'bridge::sora', null, [{ type: 'error', message: 'render crashed' }]),
			],
			pending: 0,
			pendingModelIds: [],
			pendingStartedAt: [],
			pendingSourceMediaIds: [],
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

	it('keeps every split branch its input thumbnail — failed, generating, or done', () => {
		const { deps } = makeDeps();
		const fc = new FanoutController(deps);
		// A split fan-out (one prompt, N input images): each column's thumbnail is
		// the only thing saying which input it belongs to, so a reload must not
		// blank it. Three provenance sources, one per column state.
		fc.syncFromServer({
			parentMessageId: 'u1',
			avatar: false,
			kind: 'image',
			siblings: [
				// done → off the output media row
				imageSibling('ok', 'bridge::sdxl', 'in-a'),
				// failed → off the error part (there is no output media row)
				mediaSibling('bad', 'bridge::sdxl', 'in-b', [
					{ type: 'error', message: 'upstream said no' },
				]),
			],
			pending: 1,
			pendingModelIds: ['bridge::sdxl'],
			pendingStartedAt: [1000],
			// still generating → off the in-flight registry
			pendingSourceMediaIds: ['in-c'],
		});
		expect(fc.columns.map((c) => c.inputMediaId)).toEqual(['in-a', 'in-b', 'in-c']);
		// The failed column also carries the handle discard needs.
		expect(fc.columns[1]).toMatchObject({ status: 'error', errorMessageId: 'bad' });
	});

	it('derives a recovered column kind from the persisted media when the model id no longer resolves', () => {
		const { deps } = makeDeps();
		const fc = new FanoutController(deps);
		// 'bridge::sora' isn't in MODELS (endpoint dropped from config / renamed),
		// but the persisted video part is ground truth — the column must render as
		// video, not fall back to a blank chat strip.
		fc.syncFromServer({
			parentMessageId: 'u1',
			avatar: false,
			kind: null,
			siblings: [mediaSibling('v', 'bridge::sora', null, [{ type: 'video', mediaId: 'v-out' }])],
			pending: 0,
			pendingModelIds: [],
			pendingStartedAt: [],
			pendingSourceMediaIds: [],
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
			avatar: false,
			kind: 'image',
			siblings: [imageSibling('a', 'bridge::sdxl', 's')],
			pending: 1,
			pendingModelIds: [''],
			pendingStartedAt: [1000],
			pendingSourceMediaIds: [null],
		});
		expect(fc.comparing).toBe(true);
		expect(fc.streaming).toBe(true); // the pending placeholder
		expect(fc.columnsSettled).toBe(false);

		// All settled (no pending) → settled true, streaming false.
		fc.syncFromServer({
			parentMessageId: 'u1',
			avatar: false,
			kind: 'image',
			siblings: [imageSibling('a', 'bridge::sdxl', 's')],
			pending: 0,
			pendingModelIds: [],
			pendingStartedAt: [],
			pendingSourceMediaIds: [],
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
			avatar: false,
			kind: 'image',
			siblings: [],
			pending: 2,
			pendingModelIds: ['', ''],
			pendingStartedAt: [1000, 1000],
			pendingSourceMediaIds: [null, null],
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
			avatar: false,
			kind: 'image',
			siblings: [imageSibling('a', 'bridge::sdxl', 's1'), imageSibling('b', 'bridge::sdxl', 's2')],
			pending: 0,
			pendingModelIds: [],
			pendingStartedAt: [],
			pendingSourceMediaIds: [],
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

	it('discarding a FAILED live column deletes the persisted error sibling', async () => {
		// The regression: a failure is a real server-side row, but the live column
		// only ever held red text — so discard dropped the column locally and the
		// "deleted" failures all came back the next time the grid rebuilt from
		// server truth (reload / iOS suspend). The relay hands the row id back on
		// the error frame; discard must use it.
		const user = imageSibling('u1', '', null);
		user.role = 'user';
		const done = imageSibling('a1', 'bridge::sdxl', null);
		let branch = 0;
		const fetchMock = vi.fn(async (url: string) => {
			if (url.endsWith('/messages/prepare')) return jsonResponse({ userMessage: user });
			if (url.endsWith('/branch')) return { ok: true } as unknown as Response;
			branch += 1;
			return branch === 1
				? sseResponse([{ type: 'error', message: 'upstream said no', messageId: 'err-1' }])
				: sseResponse([{ type: 'done', assistantMessage: done }]);
		});
		vi.stubGlobal('fetch', fetchMock);
		const { deps } = makeDeps();
		const fc = new FanoutController(deps);
		const models: FanoutModel[] = [
			{ modelId: 'bridge::sdxl', modelKind: 'image', displayName: 'SDXL' },
			{ modelId: 'bridge::sdxl', modelKind: 'image', displayName: 'SDXL' },
		];
		await fc.send('cartoon', [], expandFanoutBranches(models, null), models);
		expect(fc.columns[0]).toMatchObject({ status: 'error', errorMessageId: 'err-1' });

		await fc.discard(fc.columns[0]);
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/conversations/c1/messages/err-1/branch',
			expect.objectContaining({ method: 'DELETE' }),
		);
		expect(fc.columns).toHaveLength(1);
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
			[
				{ modelId: 'bridge::sdxl', modelKind: 'image', displayName: 'SDXL' },
				{ modelId: 'bridge::sdxl', modelKind: 'image', displayName: 'SDXL' },
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
			avatar: false,
			kind: 'image',
			siblings: [imageSibling('a', 'bridge::sdxl', null), imageSibling('b', 'bridge::sdxl', null)],
			pending: 0,
			pendingModelIds: [],
			pendingStartedAt: [],
			pendingSourceMediaIds: [],
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
				branchBody = JSON.parse(init?.body ?? '{}') as typeof branchBody;
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
			avatar: false,
			kind: 'image',
			siblings: [imageSibling('old', 'bridge::sdxl', null)],
			pending: 0,
			pendingModelIds: [],
			pendingStartedAt: [],
			pendingSourceMediaIds: [],
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
			avatar: false,
			kind: 'image',
			siblings: [imageSibling('a', 'bridge::sdxl', null), imageSibling('b', 'bridge::sdxl', null)],
			pending: 0,
			pendingModelIds: [],
			pendingStartedAt: [],
			pendingSourceMediaIds: [],
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
		await fc.send('x', [], branches, branches);
		// Bailed before even creating the shared user message — no network at all.
		expect(fetchMock).not.toHaveBeenCalled();
		expect(state.error).toContain('Too many variations');
		expect(fc.live).toBe(false);
		vi.unstubAllGlobals();
	});

	it('settles a truncated media branch (clean EOF) so a surviving grid does not wedge', async () => {
		const user = imageSibling('u1', '', null);
		user.role = 'user';
		// A media keep-many grid: branch img1 completes; branch img2's stream ends
		// with only a `start` and no terminal done/error event (proxy idle-timeout /
		// graceful truncation). Before the fix, img2 dangled at 'streaming', keeping
		// the whole grid non-settled (no Done/Dismiss, composer disabled).
		const fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
			if (url.endsWith('/messages/prepare')) return jsonResponse({ userMessage: user });
			const modelId = (JSON.parse(init?.body ?? '{}') as { modelId: string }).modelId;
			if (modelId === 'bridge::img1') {
				return sseResponse([
					{ type: 'start', userMessage: user, assistantMessageId: '' },
					{ type: 'done', assistantMessage: imageSibling('img1-a', 'bridge::img1', null) },
				]);
			}
			return sseResponse([{ type: 'start', userMessage: user, assistantMessageId: '' }]);
		});
		vi.stubGlobal('fetch', fetchMock);
		const { deps } = makeDeps(); // interrupted() stays false
		const fc = new FanoutController(deps);
		await fc.send(
			'a cat',
			[],
			[
				{ modelId: 'bridge::img1', modelKind: 'image', displayName: 'I1', inputMediaId: null },
				{ modelId: 'bridge::img2', modelKind: 'image', displayName: 'I2', inputMediaId: null },
			],
			[
				{ modelId: 'bridge::img1', modelKind: 'image', displayName: 'I1' },
				{ modelId: 'bridge::img2', modelKind: 'image', displayName: 'I2' },
			],
		);
		// The survivor is kept AND the truncated branch settled to a terminal error.
		const byModel = Object.fromEntries(fc.columns.map((c) => [c.modelId, c.status]));
		expect(byModel['bridge::img1']).toBe('done');
		expect(byModel['bridge::img2']).toBe('error');
		// Grid is no longer "generating" and is settleable (Done/Dismiss renders).
		expect(fc.streaming).toBe(false);
		expect(fc.columnsSettled).toBe(true);
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
			[
				{ modelId: 'bridge::a', modelKind: 'chat', displayName: 'A' },
				{ modelId: 'bridge::b', modelKind: 'chat', displayName: 'B' },
				{ modelId: 'bridge::c', modelKind: 'chat', displayName: 'C' },
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
			// One model, split across two images — the recorded cart is the model,
			// not the branches.
			[{ modelId: 'bridge::sdxl', modelKind: 'image', displayName: 'SDXL' }],
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
			bodies.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>);
			return sseResponse([
				{ type: 'start', userMessage: user, assistantMessageId: '' },
				{ type: 'done', assistantMessage: imageSibling(`r${bodies.length}`, 'bridge::sdxl', 'x') },
			]);
		});
		vi.stubGlobal('fetch', fetchMock);
		const { deps } = makeDeps();
		const fc = new FanoutController(deps);

		// Mirror the page seam: split toggle → ready image ids → cross-product.
		const models: FanoutModel[] = [
			{ modelId: 'bridge::sdxl', modelKind: 'image', displayName: 'SDXL' },
			{ modelId: 'bridge::flux', modelKind: 'image', displayName: 'Flux' },
		];
		const branches = expandFanoutBranches(models, ['img-1', 'img-2']);
		expect(branches).toHaveLength(4); // 2 images × 2 models
		await fc.send('cartoon', ['img-1', 'img-2'], branches, models);

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

/**
 * Avatar comparisons run through the same controller as a turn fan-out — same
 * streaming, stop, discard, recovery and poll — and differ in exactly three
 * places. These pin those three, and the turn-mode behaviour they must not
 * disturb.
 */
describe('FanoutController — avatar comparisons', () => {
	function jsonResponse(body: unknown): Response {
		return { ok: true, json: async () => body } as unknown as Response;
	}
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

	const DESCRIPTION = mediaSibling('desc', 'bridge::claude', null, [
		{ type: 'text', text: 'a face' },
	]);
	const TWO_MODELS: FanoutModel[] = [
		{ modelId: 'bridge::sdxl', modelKind: 'image', displayName: 'SDXL' },
		{ modelId: 'bridge::flux', modelKind: 'image', displayName: 'Flux' },
	];

	/** A fetch stub that answers prepare with `siblings` and every branch with a
	 *  finished portrait, recording what was posted where. */
	function stubDraw(siblings: ChatMessage[] = []) {
		const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
		const fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
			posts.push({ url, body: JSON.parse(init?.body ?? '{}') as Record<string, unknown> });
			if (url.endsWith('/avatar/prepare')) return jsonResponse({ siblings });
			if (url.endsWith('/avatar/generate')) {
				const modelId = (JSON.parse(init?.body ?? '{}') as { modelId: string }).modelId;
				return sseResponse([
					{ type: 'start', userMessage: DESCRIPTION, assistantMessageId: '' },
					{
						type: 'done',
						assistantMessage: imageSibling(`out-${modelId}`, modelId, null),
					},
				]);
			}
			return jsonResponse({ ok: true });
		});
		vi.stubGlobal('fetch', fetchMock);
		return posts;
	}

	beforeEach(() => {
		invalidateAll.mockClear();
	});

	it('parks on the description, then draws one branch per model', async () => {
		const posts = stubDraw();
		const { deps } = makeDeps();
		const fc = new FanoutController(deps);
		await fc.sendAvatarDraw({
			sourceMessageId: 'desc',
			prompt: 'a weathered navigator',
			enhance: true,
			branches: TWO_MODELS,
		});

		// Prepare first — it decides whether the comparison may park here at all,
		// so a refusal must land before anything is dispatched or shown.
		expect(posts[0].url).toBe('/api/conversations/c1/avatar/prepare');
		expect(posts[0].body).toEqual({ sourceMessageId: 'desc' });
		// Then a branch each, on the AVATAR route: the messages route refuses an
		// assistant fan-out parent, which is what a portrait hangs off.
		expect(posts.slice(1).map((p) => p.url)).toEqual([
			'/api/conversations/c1/avatar/generate',
			'/api/conversations/c1/avatar/generate',
		]);
		// The reviewed prompt rides on every branch — the anchor still holds
		// whatever prose the model wrapped it in — and fanoutSize is what makes the
		// aggregate notification say "2 ready" rather than counting siblings.
		expect(posts[1].body).toEqual({
			fanout: true,
			sourceMessageId: 'desc',
			modelId: 'bridge::sdxl',
			prompt: 'a weathered navigator',
			enhance: true,
			fanoutSize: 2,
		});
		expect(fc.isAvatar).toBe(true);
		expect(fc.columns.map((c) => c.status)).toEqual(['done', 'done']);
	});

	it('seeds the portraits already drawn here without redrawing them', async () => {
		// The grid means "every face drawn from this description" — which is what
		// the server-truth rebuild produces after a reload, so the live grid has to
		// agree. Seeded columns are results, not branches.
		const posts = stubDraw([imageSibling('old', 'bridge::sdxl', null)]);
		const { deps } = makeDeps();
		const fc = new FanoutController(deps);
		await fc.sendAvatarDraw({
			sourceMessageId: 'desc',
			prompt: 'p',
			enhance: false,
			branches: TWO_MODELS,
		});

		expect(fc.columns.map((c) => c.branchId)[0]).toBe('old');
		expect(fc.columns).toHaveLength(3);
		// Two generate posts, not three.
		expect(posts.filter((p) => p.url.endsWith('/avatar/generate'))).toHaveLength(2);
	});

	it('shows nothing when the comparison is refused', async () => {
		// The conversation has continued past the description: prepare 409s, and the
		// user is left exactly where they were, with the reason.
		const fetchMock = vi.fn(async () => ({
			ok: false,
			status: 409,
			json: async () => ({ message: 'has moved on' }),
		}));
		vi.stubGlobal('fetch', fetchMock);
		const { deps, state } = makeDeps();
		const fc = new FanoutController(deps);
		await fc.sendAvatarDraw({
			sourceMessageId: 'desc',
			prompt: 'p',
			enhance: true,
			branches: TWO_MODELS,
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fc.comparing).toBe(false);
		expect(state.error).toContain('has moved on');
		expect(state.busy).toBe(false);
	});

	it('picking adopts the face and leaves the chat model alone', async () => {
		const posts = stubDraw();
		const { deps, state } = makeDeps();
		const fc = new FanoutController(deps);
		await fc.sendAvatarDraw({
			sourceMessageId: 'desc',
			prompt: 'p',
			enhance: true,
			branches: TWO_MODELS,
		});
		posts.length = 0;
		await fc.pick(fc.columns[0]);

		// One endpoint for both halves of the pick, so a failure can't land the face
		// without the branch.
		expect(posts).toEqual([
			{
				url: '/api/conversations/c1/avatar/pick',
				body: { messageId: 'out-bridge::sdxl' },
			},
		]);
		// An image model drew a portrait; it did not become the model this chat
		// talks to. (A turn fan-out's pick does promote it — see below.)
		expect(state.activeModel).toBeNull();
		expect(fc.comparing).toBe(false);
	});

	it('picking a turn fan-out still selects the branch and promotes its model', async () => {
		// The other side of the same branch in `pick` — the behaviour avatar mode
		// must not have taken with it.
		const posts: Array<{ url: string }> = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => {
				posts.push({ url });
				return jsonResponse({});
			}),
		);
		const { deps, state } = makeDeps();
		const fc = new FanoutController(deps);
		fc.syncFromServer({
			parentMessageId: 'u1',
			avatar: false,
			kind: 'chat',
			siblings: [mediaSibling('a', 'bridge::claude', null, [{ type: 'text', text: 'hi' }])],
			pending: 0,
			pendingModelIds: [],
			pendingStartedAt: [],
			pendingSourceMediaIds: [],
		});
		await fc.pick(fc.columns[0]);

		expect(posts[0].url).toBe('/api/conversations/c1/messages/a/select');
		expect(state.activeModel).toEqual({ id: 'bridge::claude', kind: 'chat' });
	});

	it('restores avatar mode from server truth after a reload', async () => {
		// A recovered avatar grid is indistinguishable from an image fan-out by its
		// contents, so the mode comes off the wire. Get it wrong and "use this face"
		// continues the chat with SDXL.
		const posts: Array<{ url: string }> = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => {
				posts.push({ url });
				return jsonResponse({});
			}),
		);
		const { deps, state } = makeDeps();
		const fc = new FanoutController(deps);
		fc.syncFromServer({
			parentMessageId: 'desc',
			avatar: true,
			kind: 'image',
			siblings: [imageSibling('p1', 'bridge::sdxl', null)],
			pending: 0,
			pendingModelIds: [],
			pendingStartedAt: [],
			pendingSourceMediaIds: [],
		});
		expect(fc.isAvatar).toBe(true);

		await fc.pick(fc.columns[0]);
		expect(posts[0].url).toBe('/api/conversations/c1/avatar/pick');
		expect(state.activeModel).toBeNull();
	});

	it('offers no re-roll on a recovered avatar grid', async () => {
		// Regenerate re-sends the prompt the user reviewed in the dialog, and a
		// reloaded page never saw it. The media row's promptFull is not a stand-in:
		// for an enhanced draw it holds what the ENHANCER wrote, so re-rolling from
		// it would quietly draw something else.
		const fetchMock = vi.fn(async () => jsonResponse({}));
		vi.stubGlobal('fetch', fetchMock);
		const { deps } = makeDeps();
		const fc = new FanoutController(deps);
		fc.syncFromServer({
			parentMessageId: 'desc',
			avatar: true,
			kind: 'image',
			siblings: [imageSibling('p1', 'bridge::sdxl', null)],
			pending: 0,
			pendingModelIds: [],
			pendingStartedAt: [],
			pendingSourceMediaIds: [],
		});
		expect(fc.canRegenerate).toBe(false);

		// And the backstop behind the hidden control: no column appears, nothing is
		// posted.
		await fc.regenerate(fc.columns[0]);
		expect(fc.columns).toHaveLength(1);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('does not leave an ordinary fan-out dispatching to the avatar route', async () => {
		// The controller outlives any one comparison, and a resolved avatar grid
		// leaves the mode where it was. `send` claims it back — without that, the
		// next multi-model chat send posts its branches at ../avatar/generate, which
		// would anchor replies on the wrong message and refuse.
		stubDraw();
		const { deps } = makeDeps();
		const fc = new FanoutController(deps);
		await fc.sendAvatarDraw({
			sourceMessageId: 'desc',
			prompt: 'p',
			enhance: true,
			branches: TWO_MODELS,
		});
		await fc.dismiss();
		expect(fc.isAvatar).toBe(true);

		const user = imageSibling('u1', '', null);
		user.role = 'user';
		const posts: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => {
				posts.push(url);
				if (url.endsWith('/messages/prepare')) return jsonResponse({ userMessage: user });
				return sseResponse([
					{ type: 'start', userMessage: user, assistantMessageId: '' },
					{ type: 'done', assistantMessage: mediaSibling('r', 'bridge::claude', null, []) },
				]);
			}),
		);
		await fc.send(
			'hi',
			[],
			[{ modelId: 'bridge::claude', modelKind: 'chat', displayName: 'C', inputMediaId: null }],
			[{ modelId: 'bridge::claude', modelKind: 'chat', displayName: 'C' }],
		);
		expect(fc.isAvatar).toBe(false);
		expect(posts.some((u) => u.includes('/avatar/'))).toBe(false);
	});

	it("does not carry one conversation's prompt into another's recovered grid", async () => {
		// `#avatarDraw` holds the prompt the user reviewed in the dialog, and it is
		// deliberately kept across a handoff-to-recovery so a re-roll stays possible
		// on the grid this page dispatched. It must not survive into a DIFFERENT
		// grid: leave A mid-comparison, open B which has its own parked comparison,
		// and a re-roll there would draw A's description under B's anchor and record
		// A's text as that portrait's prompt.
		//
		// One controller for both conversations on purpose — the page constructs it
		// once and navigates with it. The neighbouring recovered-grid test builds a
		// fresh controller, which is exactly why it cannot see this.
		stubDraw();
		const { deps } = makeDeps();
		const fc = new FanoutController(deps);
		await fc.sendAvatarDraw({
			sourceMessageId: 'descA',
			prompt: "A's reviewed prompt",
			enhance: true,
			branches: TWO_MODELS,
		});
		expect(fc.canRegenerate).toBe(true);

		// Navigate away without resolving, then land on B's parked comparison.
		fc.teardown();
		fc.syncFromServer({
			parentMessageId: 'descB',
			avatar: true,
			kind: 'image',
			siblings: [imageSibling('b1', 'bridge::sdxl', null)],
			pending: 0,
			pendingModelIds: [],
			pendingStartedAt: [],
			pendingSourceMediaIds: [],
		});

		expect(fc.isAvatar).toBe(true);
		expect(fc.canRegenerate).toBe(false);
	});

	it('drops the prompt when the parked anchor moves under it', async () => {
		// The case `teardown()` cannot reach, and therefore the one that proves the
		// anchor test is what closes this rather than the teardown clears: no
		// navigation happens at all. A suspend hands the live grid to recovery
		// (which keeps the prompt on purpose), and meanwhile another tab resolves
		// that comparison and parks a new one on a different anchor in the SAME
		// conversation. The rebuild follows the new anchor; the prompt must not.
		stubDraw();
		const { deps } = makeDeps();
		const fc = new FanoutController(deps);
		await fc.sendAvatarDraw({
			sourceMessageId: 'descX',
			prompt: "X's reviewed prompt",
			enhance: true,
			branches: TWO_MODELS,
		});
		fc.handoffToRecovery();
		fc.syncFromServer({
			parentMessageId: 'descY',
			avatar: true,
			kind: 'image',
			siblings: [imageSibling('y1', 'bridge::sdxl', null)],
			pending: 0,
			pendingModelIds: [],
			pendingStartedAt: [],
			pendingSourceMediaIds: [],
		});
		expect(fc.canRegenerate).toBe(false);
	});

	it('keeps the prompt when the same grid is handed to recovery', async () => {
		// The other half of the anchor test, so the rule above can't be satisfied by
		// simply dropping the prompt on every rebuild: a handoff-to-recovery rebuilds
		// the SAME anchor, this page does still hold the real prompt, and Regenerate
		// has to survive it.
		stubDraw();
		const { deps } = makeDeps();
		const fc = new FanoutController(deps);
		await fc.sendAvatarDraw({
			sourceMessageId: 'desc',
			prompt: 'p',
			enhance: true,
			branches: TWO_MODELS,
		});
		fc.handoffToRecovery();
		fc.syncFromServer({
			parentMessageId: 'desc',
			avatar: true,
			kind: 'image',
			siblings: [imageSibling('out-1', 'bridge::sdxl', null)],
			pending: 0,
			pendingModelIds: [],
			pendingStartedAt: [],
			pendingSourceMediaIds: [],
		});
		expect(fc.canRegenerate).toBe(true);
	});

	it('keeps dispatching avatar branches after a conversation switch', async () => {
		// The loop fires one branch at a time, each waiting for the prior to reach
		// the endpoint gate — and teardown() runs in that gap on a conversation
		// switch, resetting the mode. Read fresh, the next branch would build a TURN
		// body against an assistant anchor and be refused 400 by /messages, unseen:
		// the resolution has already bailed on the conversation change, so the user
		// just gets fewer candidates than they asked for.
		//
		// Aborting doesn't stop it either — markEnqueued lives in runBranch's
		// finally so a dying branch still releases the sequence, which means
		// teardown's aborts ADVANCE this loop.
		const posts: string[] = [];
		const released: Array<() => void> = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => {
				posts.push(url);
				if (url.endsWith('/avatar/prepare')) {
					return { ok: true, json: async () => ({ siblings: [] }) } as unknown as Response;
				}
				// Hold each branch's first event so the loop parks between branches,
				// which is the window this test is about.
				let release!: () => void;
				const held = new Promise<void>((r) => (release = r));
				released.push(release);
				const msg = imageSibling('p', 'bridge::sdxl', null);
				const body = new ReadableStream<Uint8Array>({
					async start(controller) {
						const enc = new TextEncoder();
						await held;
						controller.enqueue(
							enc.encode(
								`data: ${JSON.stringify({ type: 'start', userMessage: msg, assistantMessageId: '' })}\n\n`,
							),
						);
						controller.enqueue(
							enc.encode(`data: ${JSON.stringify({ type: 'done', assistantMessage: msg })}\n\n`),
						);
						controller.close();
					},
				});
				return { ok: true, body } as unknown as Response;
			}),
		);
		const { deps } = makeDeps();
		const fc = new FanoutController(deps);
		const running = fc.sendAvatarDraw({
			sourceMessageId: 'desc',
			prompt: 'p',
			enhance: true,
			branches: TWO_MODELS,
		});

		// Branch 1 is out and the loop is parked waiting for its first event.
		await vi.waitFor(() => expect(released).toHaveLength(1));
		// The user navigates away mid-dispatch.
		fc.teardown();
		// Releasing branch 1 lets the loop dispatch branch 2.
		released[0]();
		await vi.waitFor(() => expect(released).toHaveLength(2));
		released[1]();
		await running;

		// Every branch went to the avatar route. Before the snapshot, branch 2 went
		// to /messages and was refused.
		const branchPosts = posts.filter((u) => !u.endsWith('/avatar/prepare'));
		expect(branchPosts).toHaveLength(2);
		expect(branchPosts.every((u) => u.includes('/avatar/generate'))).toBe(true);

		vi.unstubAllGlobals();
	});

	it('offers a re-roll while this page still owns the draw', async () => {
		// The live half of the same rule — otherwise the test above would pass
		// against a `canRegenerate` hardcoded to false.
		stubDraw();
		const { deps } = makeDeps();
		const fc = new FanoutController(deps);
		await fc.sendAvatarDraw({
			sourceMessageId: 'desc',
			prompt: 'p',
			enhance: true,
			branches: TWO_MODELS,
		});
		expect(fc.canRegenerate).toBe(true);
	});
});
