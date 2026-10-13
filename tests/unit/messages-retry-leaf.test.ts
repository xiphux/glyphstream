/**
 * Retry must not leave the conversation rewound when nothing is generated.
 *
 * A chat retry moves the active leaf onto the retried turn's user message so
 * the history for the new attempt ends there. If the attempt then ends without
 * persisting a reply — Stop before the first token, a setup error — the leaf
 * used to stay on the user message: the reply being retried disappeared from
 * the thread (it is a child of the leaf, not a sibling of anything on-branch,
 * so no ‹N/M› control reached it) and the next send hung a user message off a
 * user message. A media retry has no history to build, so it doesn't need the
 * rewind at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';
import type { LoadedEndpoint } from '#lib/server/endpoints/config.js';

const ENDPOINT = {
	id: 'mock',
	displayName: 'Mock',
	baseUrl: 'http://localhost/v1',
	apiKey: null,
	requestTimeoutSeconds: 120,
	providerQuirk: 'passthrough',
	groupBy: 'endpoint',
	supportsTools: false,
	maxConcurrent: Infinity,
	resourceGroup: 'mock',
	resourceGroupMaxConcurrent: Infinity,
	release: null,
	contextWindow: null,
	modelContextWindows: {},
	modelPromptStyles: {},
	modelPromptHints: {},
} as unknown as LoadedEndpoint;

const mocks = vi.hoisted(() => ({
	testDb: null as unknown as TestDB,
	/** What the mocked relay does with the turn; default: persist nothing. */
	relay: null as unknown as (opts: {
		onComplete: () => void;
		userMessage: { id: string };
		conversationId: string;
	}) => void,
	jobs: [] as Array<{ anchorMessageId: string }>,
}));

vi.mock('#lib/server/db/client.js', () => ({ getDb: () => mocks.testDb, closeDb: () => {} }));
vi.mock('#lib/server/endpoints/registry.js', () => ({ getEndpoint: () => ENDPOINT }));
vi.mock('#lib/server/endpoints/list-models.js', () => ({ listAllModels: async () => [] }));
vi.mock('#lib/server/chat/tool-context.js', () => ({
	buildChatToolContext: async () => ({
		systemPrompt: null,
		toolDefs: [],
		needsApproval: () => false,
		unavailableMcpServers: [],
	}),
	augmentRequestForCanvas: async (body: unknown) => body,
}));
vi.mock('#lib/server/chat/persona-context.js', () => ({ composePersonaPrompt: () => null }));
vi.mock('#lib/server/streaming/relay.js', () => ({
	startStreamingRelay: async (opts: Parameters<typeof mocks.relay>[0]) => {
		mocks.relay(opts);
		return new ReadableStream({ start: (c) => c.close() });
	},
}));
vi.mock('#lib/server/generation/jobs.js', () => ({
	submitGenerationJob: (input: { anchorMessageId: string }) => {
		mocks.jobs.push(input);
		return new ReadableStream({ start: (c) => c.close() });
	},
}));

import { POST } from '../../src/routes/api/conversations/[id]/messages/+server';
import { createConversation } from '#lib/server/db/queries/conversations.js';
import { appendMessage, walkActiveBranch } from '#lib/server/db/queries/messages.js';
import { resetInFlight } from '#lib/server/streaming/in-flight.js';

function seedTurn(modelKind: 'chat' | 'image') {
	const u = seedUser();
	const conv = createConversation({
		userId: u.id,
		endpointId: 'mock',
		modelId: `mock::mock-${modelKind}`,
		modelKind,
	});
	const user = appendMessage({
		conversationId: conv.id,
		parentMessageId: null,
		role: 'user',
		parts: [{ type: 'text', text: 'draw a cat' }],
	});
	const reply = appendMessage({
		conversationId: conv.id,
		parentMessageId: user.id,
		role: 'assistant',
		parts: [{ type: 'text', text: 'the first answer' }],
	});
	return { conversationId: conv.id, userId: u.id, user, reply };
}

async function retry(conversationId: string, userId: string, messageId: string) {
	const url = new URL(`http://x/api/conversations/${conversationId}/messages?stream=1`);
	const request = new Request(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ regenerateFromMessageId: messageId }),
	});
	const res = await POST({
		locals: { user: { id: userId } },
		params: { id: conversationId },
		request,
		url,
	} as unknown as Parameters<typeof POST>[0]);
	await (res as Response).text();
}

const leafId = (conversationId: string) => walkActiveBranch(conversationId).at(-1)?.id;

beforeEach(() => {
	mocks.testDb = createTestDb();
	mocks.jobs = [];
	mocks.relay = (opts) => opts.onComplete();
});
afterEach(() => {
	resetInFlight();
	closeTestDb();
});

describe('retry — chat', () => {
	it('puts the leaf back when the attempt ends with nothing persisted', async () => {
		const s = seedTurn('chat');
		await retry(s.conversationId, s.userId, s.reply.id);
		expect(leafId(s.conversationId)).toBe(s.reply.id);
	});

	it('keeps the new reply when the attempt persists one', async () => {
		const s = seedTurn('chat');
		let newReply = '';
		mocks.relay = (opts) => {
			newReply = appendMessage({
				conversationId: opts.conversationId,
				parentMessageId: opts.userMessage.id,
				role: 'assistant',
				parts: [{ type: 'text', text: 'the second answer' }],
			}).id;
			opts.onComplete();
		};
		await retry(s.conversationId, s.userId, s.reply.id);
		expect(leafId(s.conversationId)).toBe(newReply);
	});
});

describe('retry — media', () => {
	it('does not rewind the leaf; the job anchors on the user message', async () => {
		const s = seedTurn('image');
		await retry(s.conversationId, s.userId, s.reply.id);
		expect(mocks.jobs).toEqual([expect.objectContaining({ anchorMessageId: s.user.id })]);
		expect(leafId(s.conversationId)).toBe(s.reply.id);
	});
});
