/**
 * Deleting a conversation while its turn is still streaming.
 *
 * The recorder persists the assistant row at end-of-stream, so a delete that
 * lands mid-turn leaves it inserting into a conversation that no longer exists.
 * That is an expected end — the reply has nowhere to go — so it must not surface
 * as a failure: no `recorder branch failed` stack, no "Persistence failed" event,
 * no error sibling. A genuine persistence failure on a conversation that still
 * exists must keep surfacing exactly as before.
 *
 * The delete route also stops the generation, so the upstream doesn't keep
 * working (and holding an endpoint slot) for a reply nobody will see.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';
import { inFlightEntryStub } from './_helpers/in-flight';

const mocks = vi.hoisted(() => ({
	testDb: null as unknown as TestDB,
	beforeResponse: null as null | (() => void),
}));

vi.mock('$lib/server/db/client', () => ({
	getDb: () => mocks.testDb,
	closeDb: () => {},
}));
vi.mock('$lib/server/endpoints/client', async (orig) => {
	const real = await orig<typeof import('$lib/server/endpoints/client')>();
	return {
		...real,
		chatCompletionStream: vi.fn(async () => {
			// Runs after the relay has started the turn and before the recorder
			// reaches end-of-stream — where a user's delete would land.
			mocks.beforeResponse?.();
			return sseResponse([textChunk('partial reply'), finishChunk('stop')]);
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

import { createConversation, deleteConversation } from '$lib/server/db/queries/conversations';
import { appendMessage, walkActiveBranch } from '$lib/server/db/queries/messages';
import { startStreamingRelay } from '$lib/server/streaming/relay';
import { registerInFlight, resetInFlight } from '$lib/server/streaming/in-flight';
import { resetEndpointGatesForTests } from '$lib/server/endpoints/concurrency';
import { DELETE } from '../../src/routes/api/conversations/[id]/+server';
import type { LoadedEndpoint } from '$lib/server/endpoints/config';
import type { ChatMessage } from '$lib/types/api';

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
const textChunk = (text: string) =>
	JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] });
const finishChunk = (reason: string) =>
	JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] });

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

let errorSpy: ReturnType<typeof vi.spyOn>;
let infoSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	mocks.testDb = createTestDb();
	mocks.beforeResponse = null;
	errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
	warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
	vi.restoreAllMocks();
	resetInFlight();
	resetEndpointGatesForTests();
	closeTestDb();
});

describe('relay — conversation deleted mid-turn', () => {
	it('drops the reply quietly: no error log, no error event', async () => {
		const s = seed();
		mocks.beforeResponse = () => {
			expect(deleteConversation(s.conversationId, s.userId).ok).toBe(true);
		};

		const events = await drainEvents(await relay(s));

		expect(events.some((e) => e.type === 'error')).toBe(false);
		expect(errorSpy).not.toHaveBeenCalled();
		expect(warnSpy).not.toHaveBeenCalled();
		expect(infoSpy).toHaveBeenCalledWith(
			expect.stringContaining(`conversation ${s.conversationId} was deleted mid-turn`),
		);
	});

	it('still reports a persistence failure on a conversation that exists', async () => {
		const s = seed();
		// The assistant insert fails while the conversation is still there — a
		// genuine persistence failure (think: disk full), not a delete.
		mocks.testDb.run(
			sql.raw(
				"CREATE TRIGGER fail_assistant_insert BEFORE INSERT ON messages WHEN NEW.role = 'assistant' BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END",
			),
		);

		const events = await drainEvents(await relay(s));

		expect(errorSpy).toHaveBeenCalledWith(
			'[stream/relay] recorder branch failed:',
			expect.anything(),
		);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: 'error',
				message: expect.stringContaining('Persistence failed') as unknown,
			}),
		);
		expect(infoSpy).not.toHaveBeenCalled();
		// The conversation is untouched apart from the failed turn.
		expect(walkActiveBranch(s.conversationId).length).toBeGreaterThan(0);
	});
});

describe('DELETE /api/conversations/[id] — stops in-flight generation', () => {
	function del(conversationId: string, userId: string) {
		const url = new URL(`http://x/api/conversations/${conversationId}`);
		return DELETE({
			locals: { user: { id: userId } },
			params: { id: conversationId },
			request: new Request(url, { method: 'DELETE' }),
			url,
		} as unknown as Parameters<typeof DELETE>[0]);
	}

	it('aborts the conversation’s in-flight entries when the owner deletes it', async () => {
		const s = seed();
		const entry = registerInFlight(s.conversationId, endpoint);

		const res = await del(s.conversationId, s.userId);

		expect(res.status).toBe(204);
		expect(entry.controller.signal.aborted).toBe(true);
	});

	it('does not touch another user’s generation', async () => {
		const s = seed();
		const intruder = seedUser();
		const entry = registerInFlight(s.conversationId, endpoint);

		await expect(del(s.conversationId, intruder.id)).rejects.toMatchObject({ status: 404 });
		expect(entry.controller.signal.aborted).toBe(false);
	});
});
