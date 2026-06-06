import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({
	testDb: null as unknown as TestDB,
	upstreamResponses: [] as Array<() => Response>,
	upstreamCalls: [] as unknown[],
}));

vi.mock('$lib/server/db/client', () => ({
	getDb: () => mocks.testDb,
	closeDb: () => {},
}));

vi.mock('$lib/server/endpoints/client', async (orig) => {
	const real = await orig<typeof import('$lib/server/endpoints/client')>();
	return {
		...real,
		chatCompletionStream: vi.fn(async (_endpoint, body) => {
			mocks.upstreamCalls.push(body);
			const next = mocks.upstreamResponses.shift();
			if (!next) {
				throw new Error('no canned upstream response left');
			}
			return next();
		}),
	};
});

// Push and title task subsystems both touch process-global state that
// isn't worth standing up in this test — stub them as no-ops.
vi.mock('$lib/server/push/notify', () => ({
	notifyConversationComplete: vi.fn(async () => {}),
}));
vi.mock('$lib/server/tasks/title-task-runner', () => ({
	startTitleTaskIfFirstExchange: vi.fn(() => Promise.resolve(null)),
	raceTitle: vi.fn(async (p: Promise<string | null>) => p),
}));

import { createConversation } from '$lib/server/db/queries/conversations';
import { appendMessage, walkActiveBranch } from '$lib/server/db/queries/messages';
import { _resetForTests, register } from '$lib/server/tools/registry';
import { startStreamingRelay } from '$lib/server/streaming/relay';
import {
	acquireEndpointSlot,
	getEndpointQueueDepth,
	resetEndpointGatesForTests,
} from '$lib/server/endpoints/concurrency';
import type { ChatCompletionRequest } from '$lib/server/endpoints/client';
import type { LoadedEndpoint } from '$lib/server/endpoints/config';
import type { ChatMessage } from '$lib/types/api';

beforeEach(() => {
	mocks.testDb = createTestDb();
	mocks.upstreamResponses = [];
	mocks.upstreamCalls = [];
	_resetForTests();
});

afterEach(() => {
	closeTestDb();
	_resetForTests();
	resetEndpointGatesForTests();
});

const endpoint: LoadedEndpoint = {
	id: 'bridge',
	displayName: 'Bridge',
	baseUrl: 'http://localhost/v1',
	apiKey: null,
	requestTimeoutSeconds: 120,
	providerQuirk: 'passthrough',
	groupBy: 'endpoint',
	supportsTools: true,
	maxConcurrent: Infinity,
};

/** Build a Response whose body is the given SSE lines, terminated by [DONE]. */
function sseResponse(records: string[]): Response {
	const enc = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const r of records) {
				controller.enqueue(enc.encode(`data: ${r}\n\n`));
			}
			controller.enqueue(enc.encode(`data: [DONE]\n\n`));
			controller.close();
		},
	});
	return new Response(stream, { status: 200 });
}

/** Stringify a single tool_call delta chunk into the streamed wire shape. */
function toolCallStartChunk(args: {
	index: number;
	id: string;
	name: string;
	args?: string;
}): string {
	return JSON.stringify({
		choices: [
			{
				delta: {
					tool_calls: [
						{
							index: args.index,
							id: args.id,
							type: 'function',
							function: { name: args.name, arguments: args.args ?? '' },
						},
					],
				},
				finish_reason: null,
			},
		],
	});
}

function finishChunk(reason: string): string {
	return JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] });
}

function textChunk(text: string): string {
	return JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] });
}

/** Drain the SSE bytes of a ReadableStream into the parsed StreamEvent objects. */
async function drainEvents(stream: ReadableStream<Uint8Array>): Promise<unknown[]> {
	const events: unknown[] = [];
	const reader = stream.getReader();
	const dec = new TextDecoder();
	let buf = '';
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		buf += dec.decode(value, { stream: true });
		// SSE frames separated by blank lines
		let idx = buf.indexOf('\n\n');
		while (idx !== -1) {
			const frame = buf.slice(0, idx);
			buf = buf.slice(idx + 2);
			// Pull the data: line(s)
			const dataLines = frame
				.split('\n')
				.filter((l) => l.startsWith('data: '))
				.map((l) => l.slice(6));
			if (dataLines.length > 0) {
				try {
					events.push(JSON.parse(dataLines.join('\n')));
				} catch {
					// ignore non-JSON sentinels in test
				}
			}
			idx = buf.indexOf('\n\n');
		}
	}
	return events;
}

function seedConversationWithUserMessage(): {
	conv: { id: string };
	user: ChatMessage;
	userId: string;
} {
	const u = seedUser();
	const conv = createConversation({
		userId: u.id,
		endpointId: 'bridge',
		modelId: 'bridge::test',
		modelKind: 'chat',
	});
	const userMsg = appendMessage({
		conversationId: conv.id,
		parentMessageId: null,
		role: 'user',
		parts: [{ type: 'text', text: 'what time is it?' }],
		contentHtml: null,
		reasoningText: null,
		finishReason: null,
		modelUsed: null,
		tokensIn: null,
		tokensOut: null,
	});
	return { conv, user: userMsg, userId: u.id };
}

describe('multi-iteration tool loop', () => {
	it('persists assistant(tool_call) → tool(result) → assistant(text) across two upstream calls', async () => {
		register({
			definition: {
				type: 'function',
				function: {
					name: 'get_current_time',
					description: 'time',
					parameters: { type: 'object', properties: {}, additionalProperties: false },
				},
			},
			execute: () => ({ content: JSON.stringify({ iso: '2026-05-26T18:42:00Z' }) }),
		});

		const { conv, user, userId } = seedConversationWithUserMessage();

		// Iteration 0: model emits a tool_call, finish_reason=tool_calls
		mocks.upstreamResponses.push(() =>
			sseResponse([
				toolCallStartChunk({
					index: 0,
					id: 'call_t',
					name: 'get_current_time',
					args: '{}',
				}),
				finishChunk('tool_calls'),
			]),
		);
		// Iteration 1: model gives the final text answer
		mocks.upstreamResponses.push(() =>
			sseResponse([textChunk("It's 2:42 PM UTC."), finishChunk('stop')]),
		);

		let onCompleteCalls = 0;
		let rebuildCalls = 0;
		const initialBody: ChatCompletionRequest = {
			model: 'bridge::test',
			messages: [{ role: 'user', content: 'what time is it?' }],
			tools: [
				{
					type: 'function',
					function: {
						name: 'get_current_time',
						description: 'time',
						parameters: { type: 'object', properties: {} },
					},
				},
			],
			tool_choice: 'auto',
		};

		const stream = await startStreamingRelay({
			conversationId: conv.id,
			userId,
			conversationTitle: 'test',
			modelKind: 'chat',
			endpoint,
			providerQuirk: 'passthrough',
			requestBody: initialBody,
			userMessage: user,
			storedModelId: 'bridge::test',
			onComplete: () => {
				onCompleteCalls++;
			},
			rebuildRequestBody: async () => {
				rebuildCalls++;
				// Test stub: in production this re-serializes the branch.
				// Here we just return a body shape that signals "iteration 1."
				return {
					...initialBody,
					messages: [...initialBody.messages, { role: 'user', content: 'follow up' }],
				};
			},
		});

		const events = await drainEvents(stream);

		// Two upstream calls happened — confirms the loop iterated.
		expect(mocks.upstreamCalls).toHaveLength(2);
		expect(rebuildCalls).toBe(1);
		expect(onCompleteCalls).toBe(1);

		// DB shape: user → assistant(tool_call) → tool(result) → assistant(text)
		const branch = walkActiveBranch(conv.id);
		expect(branch.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
		const [_u, a1, t1, a2] = branch;
		expect(a1.finishReason).toBe('tool_calls');
		expect(a1.parts.some((p) => p.type === 'tool_call')).toBe(true);
		expect(t1.parts).toEqual([
			{
				type: 'tool_result',
				toolCallId: 'call_t',
				result: JSON.stringify({ iso: '2026-05-26T18:42:00Z' }),
			},
		]);
		expect(a2.finishReason).toBe('stop');
		const a2Text = a2.parts.find((p) => p.type === 'text') as { text: string };
		expect(a2Text.text).toBe("It's 2:42 PM UTC.");

		// SSE event order — full life of one tool_call interleaved with text.
		// The empty-object args `{}` is streamed as one args_delta event;
		// then the local execution emits executing → result; then the next
		// iteration's text streams; then done.
		const types = events.map((e) => (e as { type: string }).type);
		expect(types).toEqual([
			'start',
			'tool_call_start',
			'tool_call_args_delta',
			'tool_call_executing',
			'tool_call_result',
			'text',
			'done',
		]);

		// `done` carries the FINAL assistant message (a2), not the
		// intermediate tool_call-bearing one — clients read this to
		// reconcile their in-flight bubble with the persisted row.
		const doneEvent = events.find((e) => (e as { type: string }).type === 'done') as {
			assistantMessage: ChatMessage;
		};
		expect(doneEvent.assistantMessage.id).toBe(a2.id);
	});

	it('stops after one iteration when rebuildRequestBody is not provided', async () => {
		register({
			definition: {
				type: 'function',
				function: {
					name: 'noop',
					description: 'no-op',
					parameters: { type: 'object', properties: {}, additionalProperties: false },
				},
			},
			execute: () => ({ content: 'ran' }),
		});

		const { conv, user, userId } = seedConversationWithUserMessage();
		mocks.upstreamResponses.push(() =>
			sseResponse([
				toolCallStartChunk({ index: 0, id: 'c1', name: 'noop', args: '{}' }),
				finishChunk('tool_calls'),
			]),
		);

		const stream = await startStreamingRelay({
			conversationId: conv.id,
			userId,
			conversationTitle: null,
			modelKind: 'chat',
			endpoint,
			providerQuirk: 'passthrough',
			requestBody: {
				model: 'bridge::test',
				messages: [{ role: 'user', content: 'do it' }],
			},
			userMessage: user,
			storedModelId: 'bridge::test',
			onComplete: () => {},
			// no rebuildRequestBody — single-iteration mode
		});

		await drainEvents(stream);

		// Only one upstream call even though finish_reason was tool_calls
		expect(mocks.upstreamCalls).toHaveLength(1);

		// Tool still ran and a tool message was persisted — single-iteration
		// just means we don't dispatch the *next* upstream call.
		const branch = walkActiveBranch(conv.id);
		expect(branch.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
	});

	it('hits MAX_TOOL_LOOP_ITERATIONS and emits an error rather than looping forever', async () => {
		register({
			definition: {
				type: 'function',
				function: {
					name: 'loopy',
					description: 'loop',
					parameters: { type: 'object', properties: {}, additionalProperties: false },
				},
			},
			execute: () => ({ content: 'still going' }),
		});

		const { conv, user, userId } = seedConversationWithUserMessage();
		// Every iteration keeps emitting tool_calls — never stops on its own.
		for (let i = 0; i < 10; i++) {
			mocks.upstreamResponses.push(() =>
				sseResponse([
					toolCallStartChunk({
						index: 0,
						id: `c${i}`,
						name: 'loopy',
						args: '{}',
					}),
					finishChunk('tool_calls'),
				]),
			);
		}

		const stream = await startStreamingRelay({
			conversationId: conv.id,
			userId,
			conversationTitle: null,
			modelKind: 'chat',
			endpoint,
			providerQuirk: 'passthrough',
			requestBody: {
				model: 'bridge::test',
				messages: [{ role: 'user', content: 'do it' }],
			},
			userMessage: user,
			storedModelId: 'bridge::test',
			onComplete: () => {},
			rebuildRequestBody: async () => ({
				model: 'bridge::test',
				messages: [{ role: 'user', content: 'do it' }],
			}),
		});

		const events = await drainEvents(stream);

		// MAX_TOOL_LOOP_ITERATIONS = 5 in relay.ts
		expect(mocks.upstreamCalls).toHaveLength(5);
		const errorEvent = events.find((e) => (e as { type: string }).type === 'error') as {
			message: string;
		};
		expect(errorEvent).toBeDefined();
		expect(errorEvent.message).toMatch(/safety bound/);
	});
});

// --- MCP approval halting + resume parenting ---------------------------

describe('multi-iteration tool loop with needsApproval', () => {
	it('halts after persisting a pending_approval row instead of looping', async () => {
		// The relay's defining trait when approval is required: the model
		// emits a tool_call, executeToolCalls writes a placeholder
		// tool_result with status='pending_approval' (no execute()
		// invocation), and the loop breaks BEFORE rebuildRequestBody so
		// no second upstream call fires. The resume endpoint takes over
		// from here.
		register({
			definition: {
				type: 'function',
				function: {
					name: 'mcp__fs__read_file',
					description: 'read',
					parameters: { type: 'object', properties: {} },
				},
			},
			metadata: { category: 'mcp:fs' },
			execute: () => {
				throw new Error('approval-needed tools must not execute on the halt path');
			},
		});

		const { conv, user, userId } = seedConversationWithUserMessage();
		mocks.upstreamResponses.push(() =>
			sseResponse([
				toolCallStartChunk({
					index: 0,
					id: 'call_a',
					name: 'mcp__fs__read_file',
					args: '{"path":"/tmp"}',
				}),
				finishChunk('tool_calls'),
			]),
		);

		let rebuildCalls = 0;
		const stream = await startStreamingRelay({
			conversationId: conv.id,
			userId,
			conversationTitle: 'test',
			modelKind: 'chat',
			endpoint,
			providerQuirk: 'passthrough',
			requestBody: {
				model: 'bridge::test',
				messages: [{ role: 'user', content: 'read it' }],
			},
			userMessage: user,
			storedModelId: 'bridge::test',
			onComplete: () => {},
			needsApproval: () => true,
			rebuildRequestBody: async () => {
				rebuildCalls++;
				return { model: 'bridge::test', messages: [] };
			},
		});

		const events = await drainEvents(stream);

		expect(mocks.upstreamCalls).toHaveLength(1);
		expect(rebuildCalls).toBe(0);

		const branch = walkActiveBranch(conv.id);
		expect(branch.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
		const toolMsg = branch[2];
		const part = toolMsg.parts[0] as Extract<
			import('$lib/types/api').MessagePart,
			{ type: 'tool_result' }
		>;
		expect(part.status).toBe('pending_approval');
		expect(part.result).toBe('');

		// The SSE stream carries a tool_pending_approval event so the
		// in-flight bubble can flip the Allow / Always / Reject prompt
		// in *before* the post-stream invalidate refetches the
		// persisted row.
		const types = events.map((e) => (e as { type: string }).type);
		expect(types).toContain('tool_pending_approval');
		expect(types[types.length - 1]).toBe('done');
	});

	it('initialParentMessageId parents iteration 0 to the active_leaf, not userMessage.id', async () => {
		// Approval-resume scenario in miniature: simulate the post-
		// approval state where the conversation already has user →
		// assistant1(tool_call) → tool1(completed), and the resume
		// endpoint kicks off a new relay anchored at tool1.id. Without
		// the override, iteration 0's new assistant would parent to
		// user.id and form a SIBLING of assistant1 — the branching
		// bug we shipped a fix for.
		register({
			definition: {
				type: 'function',
				function: {
					name: 'noop_tool',
					description: 'noop',
					parameters: { type: 'object', properties: {} },
				},
			},
			execute: () => ({ content: 'ok' }),
		});

		const { conv, user, userId } = seedConversationWithUserMessage();

		// Pre-seed the assistant + completed tool result that a prior
		// halted turn would have left behind.
		const a1 = appendMessage({
			conversationId: conv.id,
			parentMessageId: user.id,
			role: 'assistant',
			parts: [
				{
					type: 'tool_call',
					toolCallId: 'call_prior',
					toolName: 'noop_tool',
					arguments: '{}',
				},
			],
			contentHtml: null,
			reasoningText: null,
			finishReason: 'tool_calls',
			modelUsed: null,
			tokensIn: null,
			tokensOut: null,
		});
		const t1 = appendMessage({
			conversationId: conv.id,
			parentMessageId: a1.id,
			role: 'tool',
			parts: [{ type: 'tool_result', toolCallId: 'call_prior', result: 'previously approved' }],
			contentHtml: null,
			reasoningText: null,
			finishReason: null,
			modelUsed: null,
			tokensIn: null,
			tokensOut: null,
		});

		// Iteration 0 of the resume: model gives a plain text answer.
		mocks.upstreamResponses.push(() => sseResponse([textChunk('done.'), finishChunk('stop')]));

		await drainEvents(
			await startStreamingRelay({
				conversationId: conv.id,
				userId,
				conversationTitle: 'test',
				modelKind: 'chat',
				endpoint,
				providerQuirk: 'passthrough',
				requestBody: { model: 'bridge::test', messages: [] },
				userMessage: user,
				storedModelId: 'bridge::test',
				onComplete: () => {},
				initialParentMessageId: t1.id,
			}),
		);

		// The new assistant should land as a CHILD of t1, not a sibling
		// of a1 under the user message. Verify by walking the active
		// branch end-to-end: user → a1 → t1 → assistant2.
		const branch = walkActiveBranch(conv.id);
		expect(branch.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
		expect(branch[1].id).toBe(a1.id);
		expect(branch[2].id).toBe(t1.id);
	});
});

describe('per-endpoint concurrency gate', () => {
	it('emits `queued` and holds the turn until a slot frees', async () => {
		mocks.upstreamResponses = [() => sseResponse([textChunk('hello'), finishChunk('stop')])];
		const { conv, user, userId } = seedConversationWithUserMessage();
		const gated: LoadedEndpoint = { ...endpoint, id: 'gated', maxConcurrent: 1 };

		// Occupy the endpoint's only slot so the relay must wait in line.
		const held = await acquireEndpointSlot(gated.id, gated.maxConcurrent);

		let completed = false;
		const stream = await startStreamingRelay({
			conversationId: conv.id,
			userId,
			conversationTitle: 'test',
			modelKind: 'chat',
			endpoint: gated,
			providerQuirk: 'passthrough',
			requestBody: { model: 'bridge::test', messages: [] },
			userMessage: user,
			storedModelId: 'bridge::test',
			onComplete: () => {
				completed = true;
			},
		});

		// Drain in the background — it can't finish while the slot is held.
		const drained = drainEvents(stream);
		await new Promise((r) => setTimeout(r, 10));

		// The relay is parked in the queue: no upstream call, not complete.
		expect(getEndpointQueueDepth(gated.id)).toEqual({ active: 1, waiting: 1 });
		expect(mocks.upstreamCalls).toHaveLength(0);
		expect(completed).toBe(false);

		// Free the slot → the relay proceeds and runs the turn.
		held.release();
		const events = await drained;
		const types = events.map((e) => (e as { type: string }).type);

		// `queued` is the very first frame, ahead of `start`.
		expect(types[0]).toBe('queued');
		expect(types[1]).toBe('start');
		expect(types).toContain('done');
		expect(mocks.upstreamCalls).toHaveLength(1);
		expect(completed).toBe(true);
		// Slot released back to the gate once the turn settled.
		expect(getEndpointQueueDepth(gated.id)).toEqual({ active: 0, waiting: 0 });
	});

	it('drops a queued turn out of line when the user stops it', async () => {
		const { conv, user, userId } = seedConversationWithUserMessage();
		const gated: LoadedEndpoint = { ...endpoint, id: 'gated', maxConcurrent: 1 };
		const held = await acquireEndpointSlot(gated.id, gated.maxConcurrent);
		const abort = new AbortController();

		let completed = false;
		const stream = await startStreamingRelay({
			conversationId: conv.id,
			userId,
			conversationTitle: 'test',
			modelKind: 'chat',
			endpoint: gated,
			providerQuirk: 'passthrough',
			requestBody: { model: 'bridge::test', messages: [] },
			userMessage: user,
			storedModelId: 'bridge::test',
			abortSignal: abort.signal,
			onComplete: () => {
				completed = true;
			},
		});

		const drained = drainEvents(stream);
		await new Promise((r) => setTimeout(r, 10));
		expect(getEndpointQueueDepth(gated.id)).toEqual({ active: 1, waiting: 1 });

		// Stop while queued: the relay abandons its place in line, never calls
		// upstream, and closes without persisting an assistant row.
		abort.abort();
		const events = await drained;
		expect(mocks.upstreamCalls).toHaveLength(0);
		expect(completed).toBe(true);
		expect(walkActiveBranch(conv.id).map((m) => m.role)).toEqual(['user']);
		// The aborted waiter left the queue without taking the held slot.
		expect(getEndpointQueueDepth(gated.id)).toEqual({ active: 1, waiting: 0 });

		held.release();
	});
});
