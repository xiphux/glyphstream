/**
 * An upstream stream that fails part-way — the idle watchdog firing on a
 * stalled model, or the connection dropping — after the user has already
 * watched part of the reply arrive.
 *
 * A recorder that rethrows throws away everything streamed so far, writes an
 * error sibling instead, and sends the client two error frames, the second
 * mislabelled "Persistence failed". The received text must be kept
 * on the assistant row, with the failure recorded alongside it, and reported
 * to the client once.
 *
 * A user Stop is the other way a stream ends early, and must read as a stop:
 * the partial reply kept as `cancelled`, no error recorded, no tool run. Every
 * way out of the turn frees the endpoint slot, or a capped endpoint wedges.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';
import { inFlightEntryStub } from './_helpers/in-flight';

const mocks = vi.hoisted(() => ({
	testDb: null as unknown as TestDB,
	response: null as null | ((signal?: AbortSignal) => Response | Promise<Response>),
}));

vi.mock('#lib/server/endpoints/client.js', async (orig) => {
	const real = await orig<typeof import('#lib/server/endpoints/client.js')>();
	return {
		...real,
		chatCompletionStream: vi.fn(async (_e: unknown, _b: unknown, signal?: AbortSignal) =>
			mocks.response!(signal),
		),
	};
});
vi.mock('#lib/server/push/notify.js', () => ({
	notifyConversationComplete: vi.fn(async () => {}),
}));
vi.mock('#lib/server/tasks/title-task-runner.js', () => ({
	startTitleTaskIfFirstExchange: vi.fn(() => Promise.resolve(null)),
	raceTitle: vi.fn(async (p: Promise<string | null>) => p),
}));

import { createConversation } from '#lib/server/db/queries/conversations.js';
import { appendMessage, walkActiveBranch } from '#lib/server/db/queries/messages.js';
import { startStreamingRelay } from '#lib/server/streaming/relay.js';
import { resetInFlight } from '#lib/server/streaming/in-flight.js';
import {
	getResourceQueueDepth,
	resetEndpointGatesForTests,
} from '#lib/server/endpoints/concurrency.js';
import { _resetForTests, register } from '#lib/server/tools/registry.js';
import { notifyConversationComplete } from '#lib/server/push/notify.js';
import type { LoadedEndpoint } from '#lib/server/endpoints/config.js';
import type { ChatMessage } from '#lib/types/api.js';
import type { TurnOutcome } from '#lib/server/streaming/relay.js';

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

/** An upstream that sends `records`, goes quiet, and then fails the way the
 *  idle watchdog (or a dropped connection) makes the body read fail. The
 *  pause matters: erroring a stream discards anything a reader hasn't pulled
 *  yet, and a real stall only fires after a long silence. */
function failingSseResponse(records: string[], failure: Error): Response {
	const enc = new TextEncoder();
	let next = 0;
	const stream = new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (next < records.length) {
				controller.enqueue(enc.encode(`data: ${records[next++]}\n\n`));
				return;
			}
			await new Promise((r) => setTimeout(r, 20));
			controller.error(failure);
		},
	});
	return new Response(stream, { status: 200 });
}
/** An upstream that sends `records` and then goes quiet until `stop` is
 *  aborted, failing the body read the way an aborted fetch does. */
function stoppedSseResponse(records: string[], stop: AbortController): Response {
	const enc = new TextEncoder();
	let next = 0;
	const stream = new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (next < records.length) {
				controller.enqueue(enc.encode(`data: ${records[next++]}\n\n`));
				return;
			}
			// Let both tee branches take what was sent, then the user hits Stop.
			await new Promise((r) => setTimeout(r, 20));
			stop.abort();
			controller.error(new DOMException('The operation was aborted.', 'AbortError'));
		},
	});
	return new Response(stream, { status: 200 });
}
const toolCallChunk = (id: string, name: string) =>
	JSON.stringify({
		choices: [
			{
				delta: {
					tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '{}' } }],
				},
				finish_reason: null,
			},
		],
	});
const finishChunk = (reason: string) =>
	JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] });
const textChunk = (text: string) =>
	JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] });

async function drainEvents(stream: ReadableStream<Uint8Array>): Promise<Array<{ type?: string }>> {
	const text = await new Response(stream).text();
	return text
		.split('\n\n')
		.flatMap((frame) => frame.split('\n').filter((l) => l.startsWith('data: ')))
		.flatMap((l) => {
			try {
				return [JSON.parse(l.slice(6)) as { type?: string }];
			} catch {
				return [];
			}
		});
}

function seed(): { conversationId: string; userId: string; userMessage: ChatMessage } {
	const u = seedUser();
	const conv = createConversation({
		userId: u.id,
		endpointId: 'bridge',
		modelId: 'bridge::test',
		modelKind: 'chat',
	});
	const userMessage = appendMessage({
		conversationId: conv.id,
		parentMessageId: null,
		role: 'user',
		parts: [{ type: 'text', text: 'hello' }],
		contentHtml: null,
		reasoningText: null,
		finishReason: null,
		modelUsed: null,
		tokensIn: null,
		tokensOut: null,
	});
	return { conversationId: conv.id, userId: u.id, userMessage };
}

function relay(
	args: { conversationId: string; userId: string; userMessage: ChatMessage },
	opts: { abortSignal?: AbortSignal; endpoint?: LoadedEndpoint } = {},
) {
	return startStreamingRelay({
		abortSignal: opts.abortSignal,
		conversationId: args.conversationId,
		userId: args.userId,
		conversationTitle: 'test',
		modelKind: 'chat',
		endpoint: opts.endpoint ?? endpoint,
		providerQuirk: 'passthrough',
		requestBody: { model: 'test', messages: [{ role: 'user', content: 'hello' }] },
		userMessage: args.userMessage,
		storedModelId: 'bridge::test',
		inFlight: inFlightEntryStub(opts.endpoint ?? endpoint),
		onComplete: () => {},
	});
}

beforeEach(() => {
	mocks.testDb = createTestDb();
	_resetForTests();
	vi.mocked(notifyConversationComplete).mockClear();
	vi.spyOn(console, 'error').mockImplementation(() => {});
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
	vi.restoreAllMocks();
	resetInFlight();
	resetEndpointGatesForTests();
	_resetForTests();
	closeTestDb();
});

describe('relay — upstream stream fails mid-reply', () => {
	it.each([
		[
			'the idle watchdog fires',
			new DOMException('Upstream "bridge" stalled: no data for 60s', 'TimeoutError'),
		],
		[
			'the connection resets',
			Object.assign(new TypeError('terminated'), { cause: new Error('ECONNRESET') }),
		],
	])('keeps the partial reply when %s', async (_name, failure) => {
		const s = seed();
		mocks.response = () =>
			failingSseResponse([textChunk('The first half '), textChunk('of the answer')], failure);

		const events = await drainEvents(await relay(s));

		const errors = events.filter((e) => e.type === 'error') as Array<{ message: string }>;
		expect(errors).toHaveLength(1);
		expect(errors[0].message).toMatch(/^Upstream stream failed/);

		const branch = walkActiveBranch(s.conversationId);
		const reply = branch[branch.length - 1];
		expect(reply.role).toBe('assistant');
		expect(reply.finishReason).toBe('error');
		expect(reply.parts).toEqual([
			{ type: 'text', text: 'The first half of the answer' },
			{ type: 'error', message: errors[0].message },
		]);
		// One assistant row for the turn, not a partial-less error sibling.
		expect(branch.filter((m) => m.role === 'assistant')).toHaveLength(1);
		expect(events.some((e) => e.type === 'done')).toBe(true);
		// A failed turn isn't announced as a finished reply.
		expect(notifyConversationComplete).not.toHaveBeenCalled();
	});

	it('keeps the partial reply when the upstream streams an error object', async () => {
		const s = seed();
		mocks.response = () =>
			failingSseResponse(
				[textChunk('Half an answer'), JSON.stringify({ error: { message: 'model crashed' } })],
				new Error('unreachable: the error frame ends the stream first'),
			);

		const events = await drainEvents(await relay(s));

		const errors = events.filter((e) => e.type === 'error') as Array<{ message: string }>;
		expect(errors).toEqual([{ type: 'error', message: 'Upstream stream failed: model crashed' }]);
		const reply = walkActiveBranch(s.conversationId).at(-1)!;
		expect(reply.finishReason).toBe('error');
		expect(reply.parts).toEqual([
			{ type: 'text', text: 'Half an answer' },
			{ type: 'error', message: 'Upstream stream failed: model crashed' },
		]);
	});

	it('drops the tool calls of a stream that broke off', async () => {
		const s = seed();
		mocks.response = () =>
			failingSseResponse(
				[textChunk('Let me check. '), toolCallChunk('call_x', 'lookup')],
				Object.assign(new TypeError('terminated'), { cause: new Error('ECONNRESET') }),
			);

		await drainEvents(await relay(s));

		const reply = walkActiveBranch(s.conversationId).at(-1)!;
		expect(reply.finishReason).toBe('error');
		expect(reply.parts.some((p) => p.type === 'tool_call')).toBe(false);
	});

	it('records the failure on its own when nothing had arrived yet', async () => {
		const s = seed();
		mocks.response = () =>
			failingSseResponse(
				[],
				new DOMException('Upstream "bridge" stalled: no data for 60s', 'TimeoutError'),
			);

		await drainEvents(await relay(s));

		const reply = walkActiveBranch(s.conversationId).at(-1)!;
		expect(reply.finishReason).toBe('error');
		expect(reply.parts).toEqual([
			{ type: 'error', message: expect.stringMatching(/stalled/) as unknown },
		]);
	});
});

describe('relay — stopped before the upstream answers', () => {
	it('is a stop, not an error: no error frame, no error row', async () => {
		const s = seed();
		let requested!: () => void;
		const waiting = new Promise<void>((r) => (requested = r));
		// No headers yet (a model still loading); as `fetch` does, the request
		// rejects with an AbortError when its signal aborts.
		mocks.response = (signal) =>
			new Promise<Response>((_resolve, reject) => {
				requested();
				signal?.addEventListener('abort', () =>
					reject(new DOMException('This operation was aborted', 'AbortError')),
				);
			});
		const stop = new AbortController();
		let outcome: TurnOutcome | null = null;
		const stream = await startStreamingRelay({
			conversationId: s.conversationId,
			userId: s.userId,
			conversationTitle: 'test',
			modelKind: 'chat',
			endpoint,
			providerQuirk: 'passthrough',
			requestBody: { model: 'test', messages: [{ role: 'user', content: 'hello' }] },
			userMessage: s.userMessage,
			storedModelId: 'bridge::test',
			inFlight: inFlightEntryStub(endpoint),
			abortSignal: stop.signal,
			onComplete: () => {},
			onOutcome: (o) => (outcome = o),
		});
		const drained = drainEvents(stream);
		await waiting;
		stop.abort();
		const events = await drained;

		expect(events.filter((e) => e.type === 'error')).toEqual([]);
		expect(outcome).toEqual({ kind: 'stopped' });
		expect(walkActiveBranch(s.conversationId).map((m) => m.role)).toEqual(['user']);
	});
});

const capped: LoadedEndpoint = {
	...endpoint,
	id: 'gpu',
	maxConcurrent: 1,
	resourceGroup: 'gpu',
	resourceGroupMaxConcurrent: 1,
};

describe('relay — the user stops mid-reply', () => {
	it('keeps the partial text as a stopped reply, not an error', async () => {
		const s = seed();
		const stop = new AbortController();
		mocks.response = () =>
			stoppedSseResponse([textChunk('The first half '), textChunk('of the answer')], stop);

		const events = await drainEvents(
			await relay(s, { abortSignal: stop.signal, endpoint: capped }),
		);

		const branch = walkActiveBranch(s.conversationId);
		const assistants = branch.filter((m) => m.role === 'assistant');
		expect(assistants).toHaveLength(1);
		expect(assistants[0].finishReason).toBe('cancelled');
		expect(assistants[0].parts).toEqual([{ type: 'text', text: 'The first half of the answer' }]);
		// No error sibling hanging off the user message either.
		const siblings = mocks.testDb.all<{ id: string }>(
			`select id from messages where parent_message_id = '${s.userMessage.id}'`,
		);
		expect(siblings).toHaveLength(1);
		expect(events.some((e) => e.type === 'error')).toBe(false);
		expect(notifyConversationComplete).not.toHaveBeenCalled();
		expect(getResourceQueueDepth('gpu').active).toBe(0);
	});

	it('never runs a tool call that had fully arrived', async () => {
		const execute = vi.fn(() => ({ content: '{}' }));
		register({
			definition: {
				type: 'function',
				function: {
					name: 'lookup',
					description: 'look up',
					parameters: { type: 'object', properties: {} },
				},
			},
			execute,
		});
		const s = seed();
		const stop = new AbortController();
		mocks.response = () =>
			stoppedSseResponse([toolCallChunk('call_x', 'lookup'), finishChunk('tool_calls')], stop);

		await drainEvents(
			await relay(s, { abortSignal: stop.signal, endpoint: { ...capped, supportsTools: true } }),
		);

		expect(execute).not.toHaveBeenCalled();
		const branch = walkActiveBranch(s.conversationId);
		expect(branch.map((m) => m.role)).toEqual(['user', 'assistant']);
		expect(branch[1].finishReason).toBe('cancelled');
		expect(branch[1].parts.some((p) => p.type === 'error')).toBe(false);
		expect(getResourceQueueDepth('gpu').active).toBe(0);
	});

	it('records nothing when stopped before the upstream answered', async () => {
		const s = seed();
		const stop = new AbortController();
		mocks.response = (signal) => {
			stop.abort();
			throw signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError');
		};

		await drainEvents(await relay(s, { abortSignal: stop.signal, endpoint: capped }));

		expect(walkActiveBranch(s.conversationId).map((m) => m.role)).toEqual(['user']);
		expect(getResourceQueueDepth('gpu').active).toBe(0);
	});
});

describe('relay — the endpoint slot is freed on every way out', () => {
	it('when the upstream connection fails', async () => {
		const s = seed();
		mocks.response = () => {
			throw Object.assign(new TypeError('fetch failed'), { cause: new Error('ECONNREFUSED') });
		};

		await drainEvents(await relay(s, { endpoint: capped }));

		expect(getResourceQueueDepth('gpu').active).toBe(0);
	});
});
