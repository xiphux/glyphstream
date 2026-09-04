/**
 * The relay's handling of `react_to_message` — the two behaviors that make an
 * emoji reaction feel like one, and cost like one.
 *
 * 1. **It never renders as a tool call.** No `tool_call_start`, no args deltas,
 *    no `executing`, no `result`; one `reaction` frame instead. Every other
 *    tool's four frames are the thing that would give the surprise away.
 * 2. **It doesn't buy a second upstream round-trip.** A reaction made alongside
 *    a reply the model already wrote ends the turn. Without the short-circuit
 *    the cheapest feature in the app (one emoji) would cost a whole extra
 *    request whose only output is an empty assistant message — and on a
 *    single-GPU box that's the turn's latency, not a rounding error.
 *
 * The negative cases matter as much: a reaction with NO reply must still loop
 * (the user is owed words, not just an emoji), and a reaction alongside a real
 * tool call must still loop (the real tool needs its answer).
 */

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
			if (!next) throw new Error('no canned upstream response left');
			return next();
		}),
	};
});

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
import { reactToMessageTool } from '$lib/server/tools/react';
import { startStreamingRelay } from '$lib/server/streaming/relay';
import { resetEndpointGatesForTests } from '$lib/server/endpoints/concurrency';
import type { ChatCompletionRequest } from '$lib/server/endpoints/client';
import type { LoadedEndpoint } from '$lib/server/endpoints/config';
import type { ChatMessage, StreamReactionEvent } from '$lib/types/api';

beforeEach(() => {
	mocks.testDb = createTestDb();
	mocks.upstreamResponses = [];
	mocks.upstreamCalls = [];
	_resetForTests();
	// The barrel's side-effect registration doesn't survive _resetForTests().
	register(reactToMessageTool);
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
	resourceGroup: 'bridge',
	resourceGroupMaxConcurrent: Infinity,
	release: null,
	contextWindow: null,
	modelContextWindows: {},
	modelPromptStyles: {},
	modelPromptHints: {},
};

function sseResponse(records: string[]): Response {
	const enc = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const r of records) controller.enqueue(enc.encode(`data: ${r}\n\n`));
			controller.enqueue(enc.encode(`data: [DONE]\n\n`));
			controller.close();
		},
	});
	return new Response(stream, { status: 200 });
}

function toolCallStartChunk(args: { index: number; id: string; name: string; args?: string }) {
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

const finishChunk = (reason: string) =>
	JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] });
const textChunk = (text: string) =>
	JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] });

async function drainEvents(stream: ReadableStream<Uint8Array>): Promise<unknown[]> {
	const events: unknown[] = [];
	const reader = stream.getReader();
	const dec = new TextDecoder();
	let buf = '';
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		buf += dec.decode(value, { stream: true });
		let idx = buf.indexOf('\n\n');
		while (idx !== -1) {
			const frame = buf.slice(0, idx);
			buf = buf.slice(idx + 2);
			const dataLines = frame
				.split('\n')
				.filter((l) => l.startsWith('data: '))
				.map((l) => l.slice(6));
			if (dataLines.length > 0) {
				try {
					events.push(JSON.parse(dataLines.join('\n')));
				} catch {
					// non-JSON sentinel
				}
			}
			idx = buf.indexOf('\n\n');
		}
	}
	return events;
}

/** The `type` discriminant of a drained SSE frame. */
const eventType = (e: unknown): string => (e as { type: string }).type;

function seedConversationWithUserMessage() {
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
		parts: [{ type: 'text', text: 'I got the job!!' }],
		contentHtml: null,
		reasoningText: null,
		finishReason: null,
		modelUsed: null,
		tokensIn: null,
		tokensOut: null,
	});
	return { conv, user: userMsg, userId: u.id };
}

const initialBody: ChatCompletionRequest = {
	model: 'bridge::test',
	messages: [{ role: 'user', content: 'I got the job!!' }],
	tools: [reactToMessageTool.definition],
	tool_choice: 'auto',
};

/** Run one relay turn against the canned upstream responses already queued. */
async function runTurn(conv: { id: string }, user: ChatMessage, userId: string) {
	let rebuildCalls = 0;
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
		onComplete: () => {},
		rebuildRequestBody: async () => {
			rebuildCalls++;
			return initialBody;
		},
	});
	const events = await drainEvents(stream);
	return { events, rebuildCalls };
}

describe('reaction alongside a reply', () => {
	it('ends the turn without a second upstream call', async () => {
		const { conv, user, userId } = seedConversationWithUserMessage();
		mocks.upstreamResponses.push(() =>
			sseResponse([
				textChunk('Congratulations! That is genuinely huge.'),
				toolCallStartChunk({
					index: 0,
					id: 'call_r',
					name: 'react_to_message',
					args: '{"emoji":"🎉"}',
				}),
				finishChunk('tool_calls'),
			]),
		);

		const { rebuildCalls } = await runTurn(conv, user, userId);

		// The whole point: one request, not two.
		expect(mocks.upstreamCalls).toHaveLength(1);
		expect(rebuildCalls).toBe(0);

		// The tool still ran and its result is persisted — the model sees its own
		// reaction history next turn, which is the only thing damping frequency.
		const branch = walkActiveBranch(conv.id);
		expect(branch.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
		const toolResult = branch[2].parts[0];
		expect(toolResult).toEqual({
			type: 'tool_result',
			toolCallId: 'call_r',
			result: 'ok',
		});
	});

	it('emits a reaction frame and none of the tool_call frames', async () => {
		const { conv, user, userId } = seedConversationWithUserMessage();
		mocks.upstreamResponses.push(() =>
			sseResponse([
				textChunk('Congratulations!'),
				toolCallStartChunk({
					index: 0,
					id: 'call_r',
					name: 'react_to_message',
					args: '{"emoji":"🎉"}',
				}),
				finishChunk('tool_calls'),
			]),
		);

		const { events } = await runTurn(conv, user, userId);
		const types = events.map(eventType);

		expect(types).toEqual(['start', 'text', 'reaction', 'done']);
		expect(types).not.toContain('tool_call_start');
		expect(types).not.toContain('tool_call_args_delta');
		expect(types).not.toContain('tool_call_executing');
		expect(types).not.toContain('tool_call_result');

		const reaction = events.find((e) => eventType(e) === 'reaction') as StreamReactionEvent;
		expect(reaction.emoji).toBe('🎉');
		// Addressed to the USER message, so the badge doesn't have to be inferred
		// from stream position.
		expect(reaction.messageId).toBe(user.id);
	});

	it('drops the args deltas of a reaction split across chunks', async () => {
		// The suppression can't be a per-event name check: only the FIRST frame
		// carries the tool name. A reaction whose arguments arrive in pieces is
		// where a naive implementation leaks half a tool block.
		const { conv, user, userId } = seedConversationWithUserMessage();
		mocks.upstreamResponses.push(() =>
			sseResponse([
				textChunk('ha'),
				toolCallStartChunk({ index: 0, id: 'call_r', name: 'react_to_message', args: '{"emo' }),
				toolCallStartChunk({ index: 0, id: 'call_r', name: '', args: 'ji":"😂"}' }),
				finishChunk('tool_calls'),
			]),
		);

		const { events } = await runTurn(conv, user, userId);
		expect(events.map(eventType)).toEqual(['start', 'text', 'reaction', 'done']);
		expect((events.find((e) => eventType(e) === 'reaction') as StreamReactionEvent).emoji).toBe(
			'😂',
		);
	});
});

describe('reaction that must not short-circuit the loop', () => {
	it('keeps looping when the model reacted but wrote nothing', async () => {
		// A bare emoji is not a reply. Ending here would leave the user staring at
		// a 🎉 and no words.
		const { conv, user, userId } = seedConversationWithUserMessage();
		mocks.upstreamResponses.push(() =>
			sseResponse([
				toolCallStartChunk({
					index: 0,
					id: 'call_r',
					name: 'react_to_message',
					args: '{"emoji":"🎉"}',
				}),
				finishChunk('tool_calls'),
			]),
		);
		mocks.upstreamResponses.push(() =>
			sseResponse([textChunk('Congratulations!'), finishChunk('stop')]),
		);

		const { rebuildCalls } = await runTurn(conv, user, userId);
		expect(mocks.upstreamCalls).toHaveLength(2);
		expect(rebuildCalls).toBe(1);
		expect(walkActiveBranch(conv.id).map((m) => m.role)).toEqual([
			'user',
			'assistant',
			'tool',
			'assistant',
		]);
	});

	it('keeps looping when a real tool was called alongside the reaction', async () => {
		register({
			definition: {
				type: 'function',
				function: {
					name: 'get_current_time',
					description: 'time',
					parameters: { type: 'object', properties: {}, additionalProperties: false },
				},
			},
			execute: () => ({ content: '{"iso":"2026-09-03T00:00:00Z"}' }),
		});
		const { conv, user, userId } = seedConversationWithUserMessage();
		mocks.upstreamResponses.push(() =>
			sseResponse([
				textChunk('Let me check.'),
				toolCallStartChunk({
					index: 0,
					id: 'call_r',
					name: 'react_to_message',
					args: '{"emoji":"🎉"}',
				}),
				toolCallStartChunk({ index: 1, id: 'call_t', name: 'get_current_time', args: '{}' }),
				finishChunk('tool_calls'),
			]),
		);
		mocks.upstreamResponses.push(() =>
			sseResponse([textChunk("It's midnight."), finishChunk('stop')]),
		);

		const { events, rebuildCalls } = await runTurn(conv, user, userId);
		expect(mocks.upstreamCalls).toHaveLength(2);
		expect(rebuildCalls).toBe(1);

		// The real tool renders its block; the reaction beside it still doesn't.
		const types = events.map(eventType);
		expect(types).toContain('tool_call_start');
		expect(types).toContain('reaction');
		const starts = events.filter((e) => eventType(e) === 'tool_call_start') as Array<{
			toolName: string;
		}>;
		expect(starts.map((e) => e.toolName)).toEqual(['get_current_time']);
	});
});

describe('a reaction the model got wrong', () => {
	it('records an error result and emits no reaction frame', async () => {
		const { conv, user, userId } = seedConversationWithUserMessage();
		mocks.upstreamResponses.push(() =>
			sseResponse([
				textChunk('Nice.'),
				toolCallStartChunk({
					index: 0,
					id: 'call_r',
					name: 'react_to_message',
					args: '{"emoji":"congrats!"}',
				}),
				finishChunk('tool_calls'),
			]),
		);

		const { events } = await runTurn(conv, user, userId);
		// Invisible to the user...
		expect(events.map(eventType)).toEqual(['start', 'text', 'done']);
		// ...but visible to the model, which reads it next turn.
		const toolMsg = walkActiveBranch(conv.id)[2];
		expect(toolMsg.parts[0]).toMatchObject({ type: 'tool_result', isError: true });
	});
});
