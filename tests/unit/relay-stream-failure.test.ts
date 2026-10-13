/**
 * An upstream stream that fails part-way — the idle watchdog firing on a
 * stalled model, or the connection dropping — after the user has already
 * watched part of the reply arrive.
 *
 * The recorder used to rethrow, so everything streamed so far was thrown away,
 * an error sibling was written instead, and the client got two error frames,
 * the second mislabelled "Persistence failed". The received text must be kept
 * on the assistant row, with the failure recorded alongside it, and reported
 * to the client once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';
import { inFlightEntryStub } from './_helpers/in-flight';

const mocks = vi.hoisted(() => ({
	testDb: null as unknown as TestDB,
	response: null as null | (() => Response),
}));

vi.mock('#lib/server/db/client.js', () => ({
	getDb: () => mocks.testDb,
	closeDb: () => {},
}));
vi.mock('#lib/server/endpoints/client.js', async (orig) => {
	const real = await orig<typeof import('#lib/server/endpoints/client.js')>();
	return { ...real, chatCompletionStream: vi.fn(async () => mocks.response!()) };
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
import { resetEndpointGatesForTests } from '#lib/server/endpoints/concurrency.js';
import { notifyConversationComplete } from '#lib/server/push/notify.js';
import type { LoadedEndpoint } from '#lib/server/endpoints/config.js';
import type { ChatMessage } from '#lib/types/api.js';

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

function relay(args: { conversationId: string; userId: string; userMessage: ChatMessage }) {
	return startStreamingRelay({
		conversationId: args.conversationId,
		userId: args.userId,
		conversationTitle: 'test',
		modelKind: 'chat',
		endpoint,
		providerQuirk: 'passthrough',
		requestBody: { model: 'test', messages: [{ role: 'user', content: 'hello' }] },
		userMessage: args.userMessage,
		storedModelId: 'bridge::test',
		inFlight: inFlightEntryStub(endpoint),
		onComplete: () => {},
	});
}

beforeEach(() => {
	mocks.testDb = createTestDb();
	vi.spyOn(console, 'error').mockImplementation(() => {});
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
	vi.restoreAllMocks();
	resetInFlight();
	resetEndpointGatesForTests();
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
