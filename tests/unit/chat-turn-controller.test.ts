/**
 * Unit tests for the extracted single-turn controller. Instantiated with mock
 * deps + a URL-dispatching fetch stub emitting SSE (`data: {json}\n\n`), so the
 * send / edit / retry / approval-resume / recover state machine is exercised
 * without a live page or backend. $app/navigation + the title spinner are
 * module-mocked; the controller runs its real runes (the sveltekit() vitest
 * plugin compiles the .svelte.ts module). Mirrors fanout-controller.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const invalidateAll = vi.fn(async () => {});
vi.mock('$app/navigation', () => ({ invalidateAll: () => invalidateAll() }));
vi.mock('$lib/title-pending.svelte', () => ({
	markTitlePending: vi.fn(),
	clearTitlePending: vi.fn(),
}));

import { ChatTurnController, type ChatTurnDeps } from '$lib/chat-turn-controller.svelte';
import type { ChatMessage, ModelKind } from '$lib/types/api';

function makeDeps(overrides: Partial<ChatTurnDeps> = {}) {
	const state = {
		convId: 'c1',
		messages: [] as ChatMessage[],
		modelId: 'bridge::claude',
		modelKind: 'chat' as ModelKind | null,
		error: null as string | null,
		approvalError: null as string | null,
		approvalCleared: 0,
		title: null as string | null,
		canvases: [] as unknown[],
		nearBottom: true,
		serverInFlightSince: null as number | null,
		fanoutComparing: false,
		scrolls: 0,
	};
	const deps: ChatTurnDeps = {
		convId: () => state.convId,
		getMessages: () => state.messages,
		setMessages: (next) => (state.messages = next),
		modelId: () => state.modelId,
		modelKind: () => state.modelKind,
		setError: (m) => (state.error = m),
		setApprovalError: (m) => (state.approvalError = m),
		clearApprovalDecisions: () => (state.approvalCleared += 1),
		setTitle: (t) => (state.title = t),
		applyCanvas: (c) => state.canvases.push(c),
		isNearBottom: () => state.nearBottom,
		scrollToBottom: () => (state.scrolls += 1),
		serverInFlightSince: () => state.serverInFlightSince,
		fanoutComparing: () => state.fanoutComparing,
		...overrides,
	};
	return { deps, state };
}

function userMsg(id: string): ChatMessage {
	return msg(id, 'user');
}
function assistantMsg(id: string): ChatMessage {
	return msg(id, 'assistant');
}
function msg(id: string, role: 'user' | 'assistant'): ChatMessage {
	return {
		id,
		role,
		parts: [{ type: 'text', text: id }],
		contentHtml: null,
		reasoningText: null,
		finishReason: null,
		modelUsed: role === 'assistant' ? 'bridge::claude' : null,
		tokensIn: null,
		tokensOut: null,
		genMs: null,
		createdAt: 1,
	};
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

beforeEach(() => {
	invalidateAll.mockClear();
});

describe('ChatTurnController — send', () => {
	it('renders the optimistic user bubble, swaps it on start, appends the reply on done', async () => {
		const user = userMsg('u1');
		const assistant = assistantMsg('a1');
		const fetchMock = vi.fn(async () =>
			sseResponse([
				{ type: 'start', userMessage: user },
				{ type: 'text', chunk: 'hi' },
				{ type: 'done', assistantMessage: assistant },
			]),
		);
		vi.stubGlobal('fetch', fetchMock);
		const { deps, state } = makeDeps();
		const turn = new ChatTurnController(deps);

		await turn.send('hello', []);

		// Optimistic placeholder swapped to the canonical user message, reply appended.
		expect(state.messages.map((m) => m.id)).toEqual(['u1', 'a1']);
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/conversations/c1/messages?stream=1',
			expect.objectContaining({ method: 'POST' }),
		);
		expect(turn.streamedMessageId).toBe('a1');
		expect(turn.busy).toBe(false);
		expect(turn.inFlightOpen).toBe(false);
		expect(turn.activeAbort).toBeNull();
		expect(invalidateAll).toHaveBeenCalled();
		vi.unstubAllGlobals();
	});

	it('edit trims from the edited message onward before streaming the sibling', async () => {
		const edited = userMsg('u2-edit');
		const reply = assistantMsg('a-new');
		const fetchMock = vi.fn(async () =>
			sseResponse([
				{ type: 'start', userMessage: edited },
				{ type: 'done', assistantMessage: reply },
			]),
		);
		vi.stubGlobal('fetch', fetchMock);
		const { deps, state } = makeDeps();
		state.messages = [userMsg('u1'), assistantMsg('a1'), userMsg('u2'), assistantMsg('a2')];
		const turn = new ChatTurnController(deps);

		await turn.send('reworded', [], { editedMessageId: 'u2' });

		// Everything from u2 onward is trimmed; the edited sibling + its reply land.
		expect(state.messages.map((m) => m.id)).toEqual(['u1', 'a1', 'u2-edit', 'a-new']);
		vi.unstubAllGlobals();
	});

	it('retry trims the target and its tool chain back to the user message; no optimistic bubble', async () => {
		const reply = assistantMsg('a-retry');
		const fetchMock = vi.fn(async () => sseResponse([{ type: 'done', assistantMessage: reply }]));
		vi.stubGlobal('fetch', fetchMock);
		const { deps, state } = makeDeps();
		// u1 → a1 (iter 0) → a2 (final): retrying a2 walks back past a1 to u1.
		state.messages = [userMsg('u1'), assistantMsg('a1'), assistantMsg('a2')];
		const turn = new ChatTurnController(deps);

		await turn.send('', [], { retryFromMessageId: 'a2' });

		// No optimistic user row added; the whole assistant chain regenerates.
		expect(state.messages.map((m) => m.id)).toEqual(['u1', 'a-retry']);
		vi.unstubAllGlobals();
	});

	it('a multi-iteration tool turn does NOT optimistically append (waits for invalidate)', async () => {
		const user = userMsg('u1');
		const finalAssistant = assistantMsg('a-final');
		const fetchMock = vi.fn(async () =>
			sseResponse([
				{ type: 'start', userMessage: user },
				{ type: 'tool_call_start', toolCallId: 't1', toolName: 'search' },
				{ type: 'done', assistantMessage: finalAssistant },
			]),
		);
		vi.stubGlobal('fetch', fetchMock);
		const { deps, state } = makeDeps();
		const turn = new ChatTurnController(deps);

		await turn.send('use a tool', []);

		// sawToolCalls → the done row is NOT appended; only the user message is here,
		// the intermediate + final rows come back via invalidateAll.
		expect(state.messages.map((m) => m.id)).toEqual(['u1']);
		expect(turn.streamedMessageId).toBe('a-final');
		expect(turn.inFlightOpen).toBe(false);
		expect(invalidateAll).toHaveBeenCalled();
		vi.unstubAllGlobals();
	});

	it('surfaces an error event via setError', async () => {
		const fetchMock = vi.fn(async () => sseResponse([{ type: 'error', message: 'upstream boom' }]));
		vi.stubGlobal('fetch', fetchMock);
		const { deps, state } = makeDeps();
		const turn = new ChatTurnController(deps);

		await turn.send('hello', []);

		expect(state.error).toBe('upstream boom');
		expect(turn.inFlightOpen).toBe(false);
		expect(turn.busy).toBe(false);
		vi.unstubAllGlobals();
	});

	it('a genuine fetch failure surfaces as an error banner', async () => {
		const fetchMock = vi.fn(async () => {
			throw new Error('network down');
		});
		vi.stubGlobal('fetch', fetchMock);
		const { deps, state } = makeDeps();
		const turn = new ChatTurnController(deps);

		await turn.send('hello', []);

		expect(state.error).toBe('network down');
		expect(invalidateAll).not.toHaveBeenCalled();
		vi.unstubAllGlobals();
	});

	it('an interruption (suspend/offline) during the fetch reconciles silently, no error banner', async () => {
		const { deps, state } = makeDeps();
		const turn = new ChatTurnController(deps);
		// Model the page being hidden mid-fetch: the connection dies with a generic
		// TypeError, but the interruption flag is set, so it's treated like an abort.
		const fetchMock = vi.fn(async () => {
			turn.markHidden();
			throw new TypeError('Load failed');
		});
		vi.stubGlobal('fetch', fetchMock);

		await turn.send('hello', []);

		expect(state.error).toBeNull();
		expect(invalidateAll).toHaveBeenCalled();
		expect(turn.inFlightOpen).toBe(false);
		vi.unstubAllGlobals();
	});
});

describe('ChatTurnController — approval resume', () => {
	it('POSTs the decisions, streams the resumed reply, and clears the decisions', async () => {
		const reply = assistantMsg('a-resume');
		const fetchMock = vi.fn(async (url: string) => {
			if (url.endsWith('/tool-approval')) {
				return sseResponse([
					{ type: 'text', chunk: 'resumed' },
					{ type: 'done', assistantMessage: reply },
				]);
			}
			throw new Error(`unexpected fetch ${url}`);
		});
		vi.stubGlobal('fetch', fetchMock);
		const { deps, state } = makeDeps();
		const turn = new ChatTurnController(deps);

		await turn.submitApproval([{ toolCallId: 't1', action: 'allow' }]);

		expect(fetchMock).toHaveBeenCalledWith(
			'/api/conversations/c1/tool-approval',
			expect.objectContaining({ method: 'POST' }),
		);
		// A resume with no further tool calls appends the reply + clears decisions.
		expect(state.messages.map((m) => m.id)).toEqual(['a-resume']);
		expect(state.approvalCleared).toBe(1);
		expect(turn.approvalSubmitting).toBe(false);
		// Guard held (still on c1): the resume's inner post-stream invalidate ran,
		// plus submitApproval's outer one — two invalidations.
		expect(invalidateAll).toHaveBeenCalledTimes(2);
		vi.unstubAllGlobals();
	});

	it('reads the LIVE convId in the resume guard, so a settle after a conversation switch is skipped', async () => {
		const reply = assistantMsg('a-resume');
		const { deps, state } = makeDeps();
		const turn = new ChatTurnController(deps);
		const fetchMock = vi.fn(async (url: string) => {
			if (url.endsWith('/tool-approval')) {
				// Model the user navigating to another conversation before the resume
				// settles: the reactive convId moves off the turn's snapshot mid-stream.
				state.convId = 'c2';
				return sseResponse([{ type: 'done', assistantMessage: reply }]);
			}
			throw new Error(`unexpected fetch ${url}`);
		});
		vi.stubGlobal('fetch', fetchMock);

		await turn.submitApproval([{ toolCallId: 't1', action: 'allow' }]);

		// Pin that the resume actually reached its success path (not an early fetch
		// error, which would also yield a single invalidate but skip this) — so the
		// single-invalidate assertion below genuinely exercises the guard.
		expect(state.approvalCleared).toBe(1);
		// The in-turn guard (deps.convId() === turnConvId) is now false, so the
		// inner post-stream invalidate is skipped — only submitApproval's outer
		// invalidate runs. Regression guard: the old inline runApprovalStream took a
		// `convId` param that shadowed the reactive one, making this check
		// permanently true (dead abandon-on-switch guard); it would invalidate twice.
		expect(invalidateAll).toHaveBeenCalledTimes(1);
		vi.unstubAllGlobals();
	});
});

describe('ChatTurnController — stop / recovery / teardown', () => {
	it('recoveredInFlight reflects the server registry, the leaf, and the fan-out gate', () => {
		const { deps, state } = makeDeps();
		const turn = new ChatTurnController(deps);
		expect(turn.recoveredInFlight).toBe(false); // no server marker

		state.serverInFlightSince = 1000;
		state.messages = [userMsg('u1')];
		expect(turn.recoveredInFlight).toBe(true);

		// A trailing assistant means the generation already landed — nothing to recover.
		state.messages = [userMsg('u1'), assistantMsg('a1')];
		expect(turn.recoveredInFlight).toBe(false);

		// A fan-out comparison owns the in-flight display instead.
		state.messages = [userMsg('u1')];
		state.fanoutComparing = true;
		expect(turn.recoveredInFlight).toBe(false);
	});

	it('stop on a recovered bubble cancels server-side and re-syncs (no local abort)', async () => {
		const fetchMock = vi.fn(async () => ({ ok: true }) as Response);
		vi.stubGlobal('fetch', fetchMock);
		const { deps, state } = makeDeps();
		state.serverInFlightSince = 1000;
		state.messages = [userMsg('u1')];
		const turn = new ChatTurnController(deps);

		await turn.stop();

		expect(fetchMock).toHaveBeenCalledWith(
			'/api/conversations/c1/cancel',
			expect.objectContaining({ method: 'POST' }),
		);
		expect(invalidateAll).toHaveBeenCalled();
		vi.unstubAllGlobals();
	});

	it('stop is a no-op when nothing is in flight', async () => {
		const fetchMock = vi.fn(async () => ({ ok: true }) as Response);
		vi.stubGlobal('fetch', fetchMock);
		const { deps } = makeDeps();
		const turn = new ChatTurnController(deps);

		await turn.stop();

		expect(fetchMock).not.toHaveBeenCalled();
		vi.unstubAllGlobals();
	});

	it('teardown aborts the in-flight fetch and clears the turn state', () => {
		const { deps } = makeDeps();
		const turn = new ChatTurnController(deps);
		const abort = new AbortController();
		turn.activeAbort = abort;
		turn.busy = true;
		turn.inFlightOpen = true;
		turn.approvalSubmitting = true;

		turn.teardown();

		expect(abort.signal.aborted).toBe(true);
		expect(turn.activeAbort).toBeNull();
		expect(turn.busy).toBe(false);
		expect(turn.inFlightOpen).toBe(false);
		expect(turn.approvalSubmitting).toBe(false);
	});

	it('shares the interruption flags between markHidden/markOffline and interrupted', () => {
		const { deps } = makeDeps();
		const turn = new ChatTurnController(deps);
		expect(turn.interrupted).toBe(false);
		turn.markHidden();
		expect(turn.interrupted).toBe(true);
		expect(turn.wasHiddenDuringFetch).toBe(true);
		turn.clearInterruptedFlags();
		expect(turn.interrupted).toBe(false);
		turn.markOffline();
		expect(turn.wasOfflineDuringFetch).toBe(true);
		expect(turn.interrupted).toBe(true);
	});
});
