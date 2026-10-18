/**
 * The relay's model-stats counters: one `turn` per settled turn, keyed off the
 * final row; a failure is an `error` and not a turn (matching the backfill);
 * a stop and a length cut-off are turns with a flag.
 *
 * Harness copied from relay-stream-failure.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';
import { inFlightEntryStub } from './_helpers/in-flight';

const mocks = vi.hoisted(() => ({
	testDb: null as unknown as TestDB,
	response: null as null | (() => Response),
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
import { appendMessage } from '#lib/server/db/queries/messages.js';
import { modelStatsDaily } from '#lib/server/db/schema.js';
import { startStreamingRelay } from '#lib/server/streaming/relay.js';
import { resetInFlight } from '#lib/server/streaming/in-flight.js';
import { resetEndpointGatesForTests } from '#lib/server/endpoints/concurrency.js';
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

function sseResponse(records: string[]): Response {
	const enc = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const r of records) controller.enqueue(enc.encode(`data: ${r}\n\n`));
			controller.enqueue(enc.encode('data: [DONE]\n\n'));
			controller.close();
		},
	});
	return new Response(stream, { status: 200 });
}
const finish = (reason: string) =>
	JSON.stringify({
		choices: [{ delta: {}, finish_reason: reason }],
		usage: { prompt_tokens: 5, completion_tokens: 42 },
	});

function tally(): Record<string, { count: number; sum: number }> {
	const out: Record<string, { count: number; sum: number }> = {};
	for (const r of mocks.testDb.select().from(modelStatsDaily).all()) {
		out[r.metric] = { count: r.count, sum: r.sum };
	}
	return out;
}

describe('relay — model stats', () => {
	it('counts a completed turn with its tokens out', async () => {
		const s = seed();
		mocks.response = () => sseResponse([textChunk('Hi '), textChunk('there'), finish('stop')]);
		await drainEvents(await relay(s));
		expect(tally().turn).toEqual({ count: 1, sum: 42 });
		expect(tally().error).toBeUndefined();
	});

	it('flags a turn cut off at the length limit', async () => {
		const s = seed();
		mocks.response = () => sseResponse([textChunk('Hi'), finish('length')]);
		await drainEvents(await relay(s));
		expect(tally().turn?.count).toBe(1);
		expect(tally().truncated?.count).toBe(1);
	});

	it('counts a reply that failed part-way as an error, not a turn', async () => {
		const s = seed();
		mocks.response = () => failingSseResponse([textChunk('Half')], new Error('ECONNRESET'));
		await drainEvents(await relay(s));
		expect(tally().error?.count).toBe(1);
		expect(tally().turn).toBeUndefined();
	});

	it('counts an upstream that refused outright as an error', async () => {
		const s = seed();
		mocks.response = () => {
			throw new Error('connect ECONNREFUSED');
		};
		await drainEvents(await relay(s));
		expect(tally().error?.count).toBe(1);
		expect(tally().turn).toBeUndefined();
	});
});
