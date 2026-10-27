/**
 * A reply's push preview leaves out its check-in marker: the bubbles hide the
 * model's note to itself, and the lock screen mustn't read it out either.
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

function sse(records: string[]): Response {
	const enc = new TextEncoder();
	return new Response(
		new ReadableStream<Uint8Array>({
			start(c) {
				for (const r of records) c.enqueue(enc.encode(`data: ${r}\n\n`));
				c.enqueue(enc.encode('data: [DONE]\n\n'));
				c.close();
			},
		}),
		{ status: 200 },
	);
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
	vi.mocked(notifyConversationComplete).mockClear();
});
afterEach(() => {
	resetInFlight();
	resetEndpointGatesForTests();
	closeTestDb();
});

describe('relay — push preview', () => {
	it('drops a check-in marker from the preview', async () => {
		const s = seed();
		mocks.response = () =>
			sse([
				textChunk('good luck!\n\n[later 2h: ask how the interview went]'),
				JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
			]);
		await drainEvents(await relay(s));
		expect(notifyConversationComplete).toHaveBeenCalledWith(
			expect.objectContaining({ previewText: 'good luck!' }),
		);
	});
});
