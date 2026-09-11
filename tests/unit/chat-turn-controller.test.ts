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
const invalidate = vi.fn(async (_key: string) => {});
vi.mock('$app/navigation', () => ({
	invalidateAll: () => invalidateAll(),
	invalidate: (key: string) => invalidate(key),
}));
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
		serverGeneratingSince: null as number | null,
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
		serverGeneratingSince: () => state.serverGeneratingSince,
		setServerGeneratingSince: (since) => (state.serverGeneratingSince = since),
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
/** An assistant row mid-tool-loop: it carries the tool_call the relay just
 *  streamed, and the tools haven't run (or persisted their rows) yet. */
function toolCallAssistantMsg(id: string): ChatMessage {
	return {
		...msg(id, 'assistant'),
		parts: [
			{ type: 'tool_call', toolCallId: `call_${id}`, toolName: 'fetch_url', arguments: '{}' },
		],
		finishReason: 'tool_calls',
	};
}
/** An assistant row carrying only a reaction tool_call — the shape the relay
 *  leaves as the branch leaf when it short-circuits a turn on one. */
function reactionAssistantMsg(id: string): ChatMessage {
	return {
		...msg(id, 'assistant'),
		parts: [
			{ type: 'text', text: 'Congratulations!' },
			{
				type: 'tool_call',
				toolCallId: `call_${id}`,
				toolName: 'react_to_message',
				arguments: '{"emoji":"🎉"}',
			},
		],
		finishReason: 'tool_calls',
	};
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
	invalidate.mockClear();
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
		// A plain single-iteration append reconciles entirely from the stream —
		// `onStart` swapped in the canonical user row, `onDone` appended the reply —
		// so it must NOT re-read the conversation. Only the sidebar is refreshed,
		// for the generated title and the updated_at re-sort.
		expect(invalidateAll).not.toHaveBeenCalled();
		expect(invalidate).toHaveBeenCalledWith('app:conversations');
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

describe('ChatTurnController — slot acquisition', () => {
	/** A stream the test feeds one event at a time, so mid-turn state is
	 *  observable instead of only its settled remains. */
	function pushableSse() {
		let ctrl!: ReadableStreamDefaultController<Uint8Array>;
		const enc = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			start(c) {
				ctrl = c;
			},
		});
		return {
			res: { ok: true, body } as unknown as Response,
			push: async (e: unknown) => {
				ctrl.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
				// A macrotask, not a microtask drain: the reader's `await read()`
				// resolves on the stream's own scheduling, and a microtask flush
				// returns before the handler has run — which makes a "still null"
				// assertion pass without the event ever being delivered.
				await new Promise((r) => setTimeout(r, 0));
			},
			close: () => ctrl.close(),
		};
	}

	it('does not report a slot during the pre-gate phases', async () => {
		// `progress` carries the phases that run BEFORE `acquireEndpointSlot`:
		// prompt enhancement, and "Freeing GPU memory…" during a handover
		// eviction. Both clear the queue notice, so the ABSENCE of that notice
		// never meant "generating" — which is why the sidebar's mark asks
		// `inFlightStartedAt` instead. On a shared GPU those phases are seconds
		// long, and reporting them as running is exactly the "everything looks
		// busy" confusion the queued mark exists to end.
		const sse = pushableSse();
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => sse.res),
		);
		const { deps } = makeDeps();
		const turn = new ChatTurnController(deps);
		const sending = turn.send('draw me something', []);

		await sse.push({ type: 'progress', percent: null, status: 'Enhancing prompt…' });
		expect(turn.inFlightQueued).toBe(null);
		expect(turn.inFlightStartedAt).toBe(null);

		await sse.push({ type: 'progress', percent: null, status: 'Freeing GPU memory…' });
		expect(turn.inFlightStartedAt).toBe(null);

		// The gate grants the slot.
		await sse.push({ type: 'start', userMessage: userMsg('u1') });
		expect(turn.inFlightStartedAt).not.toBe(null);

		await sse.push({ type: 'done', assistantMessage: assistantMsg('a1') });
		sse.close();
		await sending;
	});

	it('keeps reporting queued while the gate says so', async () => {
		const sse = pushableSse();
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => sse.res),
		);
		const { deps } = makeDeps();
		const turn = new ChatTurnController(deps);
		const sending = turn.send('hello', []);

		await sse.push({ type: 'queued', ahead: 2 });
		expect(turn.inFlightQueued).toEqual({ ahead: 2 });
		expect(turn.inFlightStartedAt).toBe(null);

		await sse.push({ type: 'start', userMessage: userMsg('u1') });
		expect(turn.inFlightQueued).toBe(null);
		expect(turn.inFlightStartedAt).not.toBe(null);

		await sse.push({ type: 'done', assistantMessage: assistantMsg('a1') });
		sse.close();
		await sending;
	});

	it('treats content as proof of a slot when no start frame arrived', async () => {
		// The mark now depends on this field, so a stream that reaches content
		// without a `start` must not leave a live generation wearing the queued
		// ring for its whole run.
		const sse = pushableSse();
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => sse.res),
		);
		const { deps } = makeDeps();
		const turn = new ChatTurnController(deps);
		const sending = turn.send('hello', []);

		await sse.push({ type: 'text', chunk: 'already talking' });
		expect(turn.inFlightStartedAt).not.toBe(null);

		await sse.push({ type: 'done', assistantMessage: assistantMsg('a1') });
		sse.close();
		await sending;
	});

	it('clears the start time with the turn, so the next one does not inherit it', async () => {
		const first = pushableSse();
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => first.res),
		);
		const { deps } = makeDeps();
		const turn = new ChatTurnController(deps);
		const sending = turn.send('hello', []);
		await first.push({ type: 'start', userMessage: userMsg('u1') });
		await first.push({ type: 'done', assistantMessage: assistantMsg('a1') });
		first.close();
		await sending;

		// A stale timestamp here would paint the NEXT send as already on the GPU
		// while it is still queueing.
		expect(turn.inFlightStartedAt).toBe(null);
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

	// The page routes setApprovalError into the same banner as setError. It used
	// to write a `$state` that nothing rendered, so a resume that failed here was
	// invisible to the user — they saw the approval prompt sit there, unexplained.
	it('reports a failed resume through setApprovalError', async () => {
		const fetchMock = vi.fn(async (url: string) => {
			if (url.endsWith('/tool-approval')) throw new Error('upstream exploded');
			throw new Error(`unexpected fetch ${url}`);
		});
		vi.stubGlobal('fetch', fetchMock);
		const { deps, state } = makeDeps();
		const turn = new ChatTurnController(deps);

		await turn.submitApproval([{ toolCallId: 't1', action: 'allow' }]);

		expect(state.approvalError).toBe('upstream exploded');
		// The latch must release, or the prompt stays wedged behind approvalBusy.
		expect(turn.approvalSubmitting).toBe(false);
		vi.unstubAllGlobals();
	});

	it('stays silent when the resume is aborted by Stop', async () => {
		const fetchMock = vi.fn(async (url: string) => {
			if (url.endsWith('/tool-approval')) {
				throw Object.assign(new Error('aborted'), { name: 'AbortError' });
			}
			throw new Error(`unexpected fetch ${url}`);
		});
		vi.stubGlobal('fetch', fetchMock);
		const { deps, state } = makeDeps();
		const turn = new ChatTurnController(deps);

		await turn.submitApproval([{ toolCallId: 't1', action: 'allow' }]);

		// Clicking Stop is a deliberate user action, not an error to report.
		expect(state.approvalError).toBeNull();
		expect(turn.approvalSubmitting).toBe(false);
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

	it('still recovers while a tool call is executing, though the leaf is an assistant row', () => {
		// The trap: the relay persists each iteration's assistant row with
		// advanceActiveLeaf, so from the moment a tool-call iteration stops
		// streaming until the tools return and their role:'tool' rows land, the
		// branch leaf IS an assistant row — for as long as an MCP call, a search,
		// or a Python run takes. Reading that as "the turn landed" drops the
		// recovered bubble (and the sidebar's generating dot) mid-generation.
		const { deps, state } = makeDeps();
		const turn = new ChatTurnController(deps);
		state.serverInFlightSince = 1000;
		state.messages = [userMsg('u1'), toolCallAssistantMsg('a1')];
		expect(turn.recoveredInFlight).toBe(true);

		// The same row once the turn genuinely settles: text only, no tool_call.
		state.messages = [userMsg('u1'), assistantMsg('a1')];
		expect(turn.recoveredInFlight).toBe(false);
	});

	it('treats a trailing reaction tool_call as a settled turn, unlike a real one', () => {
		// The client's own cheap path appends the assistant row without ever
		// fetching its tool row, so a trailing assistant whose only call is a
		// reaction is a finished turn.
		const { deps, state } = makeDeps();
		const turn = new ChatTurnController(deps);
		state.serverInFlightSince = 1000;
		state.messages = [userMsg('u1'), reactionAssistantMsg('a1')];
		expect(turn.recoveredInFlight).toBe(false);

		// A real tool call alongside the reaction still reads as mid-flight — the
		// exclusion is per-part, not "any reaction makes the row settled".
		state.messages = [
			userMsg('u1'),
			{
				...reactionAssistantMsg('a1'),
				parts: [
					...reactionAssistantMsg('a1').parts,
					{ type: 'tool_call', toolCallId: 'call_x', toolName: 'fetch_url', arguments: '{}' },
				],
			},
		];
		expect(turn.recoveredInFlight).toBe(true);
	});

	it('still recovers while a TEXTLESS reaction turn waits on its second iteration', () => {
		// The shape no test used to construct, and the reason a regression slipped
		// through. The relay only short-circuits when the reaction came WITH text;
		// with none it persists the tool row, advances the leaf onto it, and makes
		// a second upstream call to get the actual reply. On chat templates where
		// content and tool_calls are mutually exclusive that is EVERY reaction, and
		// the window is a whole generation wide.
		//
		// Resolving past that tool row to the empty reply reported the turn as
		// settled: no recovery bubble, composer re-enabled, and the reply landing
		// in a tab that had stopped listening for it.
		const { deps, state } = makeDeps();
		const turn = new ChatTurnController(deps);
		state.serverInFlightSince = 1000;
		state.messages = [
			userMsg('u1'),
			{
				...reactionAssistantMsg('a1'),
				parts: [
					{ type: 'text', text: '' },
					{
						type: 'tool_call',
						toolCallId: 'call_a1',
						toolName: 'react_to_message',
						arguments: '{"emoji":"🎉"}',
					},
				],
			},
			{
				...msg('t1', 'assistant'),
				role: 'tool',
				parts: [{ type: 'tool_result', toolCallId: 'call_a1', result: 'ok' }],
			} as ChatMessage,
		];
		expect(turn.recoveredInFlight).toBe(true);
	});

	it('recovery poll rides the branch-walk-free variant and finishes on the registry alone', async () => {
		// Two things worth pinning. (1) The URL: the default GET serializes every
		// message on the branch (content_html included) per tick, to answer a
		// yes/no — `?fanout=1` answers it without the walk. (2) The predicate:
		// gating on the registry, not on "an assistant row landed", because
		// mid-tool-loop the branch leaf IS an assistant row and reading that as
		// done would stop the poll while the server still had iterations to run.
		vi.useFakeTimers();
		const urls: string[] = [];
		let inFlightSince: number | null = 5000;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => {
				urls.push(url);
				return { ok: true, json: async () => ({ inFlightSince }) } as unknown as Response;
			}),
		);
		const { deps } = makeDeps();
		const turn = new ChatTurnController(deps);
		const stop = turn.startRecoveryPoll();
		try {
			await vi.advanceTimersByTimeAsync(4000);
			expect(urls).toEqual(['/api/conversations/c1?fanout=1']);
			// Registry still populated → keep polling, even though no message list
			// was consulted at all.
			expect(invalidateAll).not.toHaveBeenCalled();

			inFlightSince = null;
			await vi.advanceTimersByTimeAsync(4000);
			expect(invalidateAll).toHaveBeenCalledTimes(1);

			// Terminated: no further ticks once it has resolved.
			const seen = urls.length;
			await vi.advanceTimersByTimeAsync(12000);
			expect(urls.length).toBe(seen);
		} finally {
			stop();
			vi.unstubAllGlobals();
			vi.useRealTimers();
		}
	});

	it('a recovered turn with no slot yet reads as queued, and stops once it has one', () => {
		// The iOS-suspension case on a max_concurrent=1 endpoint: the page reloads
		// onto a turn that is registered but still waiting behind the gate. It
		// used to recover as plain "generating", timer running from registration.
		const { deps, state } = makeDeps();
		state.serverInFlightSince = 1000;
		state.messages = [userMsg('u1')];
		const turn = new ChatTurnController(deps);
		expect(turn.recoveredInFlight).toBe(true);
		expect(turn.recoveredQueued).toBe(true);

		state.serverGeneratingSince = 9000;
		expect(turn.recoveredQueued).toBe(false);
	});

	it('recovery poll carries the gate handover to the page', async () => {
		// A turn queued at load gets its slot while the user watches; the bubble
		// only learns that from the poll, so the poll has to hand it over.
		vi.useFakeTimers();
		let inFlightGeneratingSince: number | null = null;
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					({
						ok: true,
						json: async () => ({ inFlightSince: 5000, inFlightGeneratingSince }),
					}) as unknown as Response,
			),
		);
		const { deps, state } = makeDeps();
		state.serverInFlightSince = 5000;
		state.messages = [userMsg('u1')];
		const turn = new ChatTurnController(deps);
		const stop = turn.startRecoveryPoll();
		try {
			await vi.advanceTimersByTimeAsync(4000);
			expect(turn.recoveredQueued).toBe(true);

			inFlightGeneratingSince = 7000;
			await vi.advanceTimersByTimeAsync(4000);
			expect(state.serverGeneratingSince).toBe(7000);
			expect(turn.recoveredQueued).toBe(false);
		} finally {
			stop();
			vi.unstubAllGlobals();
			vi.useRealTimers();
		}
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
