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

import {
	FanoutController,
	type FanoutDeps,
	type FanoutServerState,
} from '$lib/fanout-controller.svelte';
import type { ChatMessage, ModelEntry } from '$lib/types/api';

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
	return {
		id,
		role: 'assistant',
		parts: [{ type: 'image', mediaId: `${id}-out` }],
		contentHtml: null,
		reasoningText: null,
		finishReason: null,
		modelUsed,
		tokensIn: null,
		tokensOut: null,
		createdAt: 1,
		sourceMediaId,
	};
}

describe('FanoutController — server recovery', () => {
	it('rebuilds the grid from server truth: done siblings + pending placeholders', () => {
		const { deps } = makeDeps();
		const fc = new FanoutController(deps);
		const server: FanoutServerState = {
			parentMessageId: 'u1',
			kind: 'image',
			siblings: [imageSibling('a', 'bridge::sdxl', 'src-1')],
			pending: 2,
			pendingModelIds: ['bridge::sdxl', 'bridge::claude'],
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
		fc.syncFromServer({ parentMessageId: 'u1', kind: 'image', siblings: [], pending: 3 });
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
		});
		expect(fc.columns).toHaveLength(1);
		// Marker cleared server-side (pick/dismiss elsewhere) → grid clears.
		fc.syncFromServer({ parentMessageId: null, kind: null, siblings: [], pending: 0 });
		expect(fc.columns).toHaveLength(0);
		expect(fc.userMessageId).toBeNull();
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
		});
		expect(fc.streaming).toBe(false);
		expect(fc.columnsSettled).toBe(true);
	});
});

describe('FanoutController — teardown + handoff', () => {
	it('teardown clears the grid + live flag', () => {
		const { deps } = makeDeps();
		const fc = new FanoutController(deps);
		fc.syncFromServer({ parentMessageId: 'u1', kind: 'image', siblings: [], pending: 2 });
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

	it('regenerate tells the server which sibling it replaces (recovery shadow)', async () => {
		let branchBody: { replacesMessageId?: unknown } = {};
		const fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
			if (url.includes('?stream=1')) {
				branchBody = JSON.parse(init?.body ?? '{}');
				return sseResponse([
					{ type: 'start', userMessage: imageSibling('u1', '', null), assistantMessageId: '' },
					{ type: 'done', assistantMessage: imageSibling('new', 'bridge::sdxl', null) },
				]);
			}
			return jsonResponse({}); // the old-image DELETE
		});
		vi.stubGlobal('fetch', fetchMock);
		const { deps } = makeDeps();
		const fc = new FanoutController(deps);
		fc.syncFromServer({
			parentMessageId: 'u1',
			kind: 'image',
			siblings: [imageSibling('old', 'bridge::sdxl', null)],
			pending: 0,
		});
		await fc.regenerate(fc.columns[0]);
		expect(branchBody.replacesMessageId).toBe('old');
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
});
