/**
 * A send that lands while an earlier turn is still thinking (no reply text
 * yet) supersedes and aborts that turn. The aborted turn's empty row must not
 * take the active leaf off the new message — and a check-in settling that
 * turn must not delete the reminder's subtree, which now holds the user's
 * message.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb } from './_helpers/test-db';
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
	maxConcurrent: 1,
	resourceGroup: 'mock',
	resourceGroupMaxConcurrent: 1,
	release: null,
	contextWindow: null,
	modelContextWindows: {},
	modelPromptStyles: {},
	modelPromptHints: {},
} as unknown as LoadedEndpoint;

const mocks = vi.hoisted(() => ({
	upstream: [] as Array<(signal?: AbortSignal) => Response>,
	calls: 0,
}));

vi.mock('#lib/server/endpoints/client.js', async (orig) => ({
	...(await orig<typeof import('#lib/server/endpoints/client.js')>()),
	chatCompletionStream: vi.fn(async (_endpoint: unknown, _body: unknown, signal?: AbortSignal) => {
		mocks.calls++;
		const next = mocks.upstream.shift();
		if (!next) throw new Error('no canned upstream response left');
		return next(signal);
	}),
}));
vi.mock('#lib/server/endpoints/registry.js', () => ({
	getEndpoint: (id: string) => (id === 'mock' ? ENDPOINT : undefined),
}));
vi.mock('#lib/server/endpoints/list-models.js', () => ({
	listAllModels: async () => [{ endpointId: 'mock', upstreamId: 'm', supportsTools: false }],
}));
vi.mock('#lib/server/endpoints/config.js', async (orig) => ({
	...(await orig<typeof import('#lib/server/endpoints/config.js')>()),
	getCheckInsConfig: () => ({ enabled: true }),
	getMaxToolLoopIterations: () => 4,
}));
vi.mock('#lib/server/tools/index.js', async () => await import('#lib/server/tools/registry.js'));
vi.mock('#lib/server/mcp/bootstrap.js', () => ({ awaitMcpReady: async () => {} }));
vi.mock('#lib/server/mcp/registry.js', () => ({
	getUserServerStates: async () => [],
	listServerCatalog: () => [],
	getMcpServerCfg: () => undefined,
}));
vi.mock('#lib/server/mcp/tool-bridge.js', () => ({
	buildUserMcpToolDefinitions: async () => [],
	buildUserDeferredToolCatalog: async () => [],
	registerUserMcpTools: async () => {},
}));
vi.mock('#lib/server/push/notify.js', async (orig) => ({
	...(await orig<typeof import('#lib/server/push/notify.js')>()),
	notifyConversationComplete: vi.fn(async () => {}),
}));
vi.mock('#lib/server/tasks/title-task-runner.js', () => ({
	startTitleTaskIfFirstExchange: vi.fn(() => Promise.resolve(null)),
	raceTitle: async () => null,
}));

import { POST } from '../../src/routes/api/conversations/[id]/messages/+server';
import { createConversation } from '#lib/server/db/queries/conversations.js';
import { appendMessage, walkActiveBranch } from '#lib/server/db/queries/messages.js';
import { resetEndpointGatesForTests } from '#lib/server/endpoints/concurrency.js';
import { _resetForTests } from '#lib/server/tools/registry.js';
import { cancelInFlightGenerations } from '#lib/server/streaming/cancel.js';
import { getInFlightSince, resetInFlight } from '#lib/server/streaming/in-flight.js';
import { runCheckInSweep } from '#lib/server/check-ins/runner.js';
import { scheduleCheckInFromReply } from '#lib/server/check-ins/schedule.js';

const enc = new TextEncoder();
const frame = (o: object) => enc.encode(`data: ${JSON.stringify(o)}\n\n`);
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 27, 15, 0);

beforeEach(() => {
	createTestDb();
	mocks.upstream = [];
	mocks.calls = 0;
	_resetForTests();
});
afterEach(() => {
	closeTestDb();
	resetInFlight();
	resetEndpointGatesForTests();
	_resetForTests();
});

async function idle(conversationId: string): Promise<void> {
	for (let i = 0; i < 400; i++) {
		if (getInFlightSince(conversationId) === null) {
			await new Promise((r) => setTimeout(r, 30));
			return;
		}
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error('turn never finished');
}

const reasoningThenHang = (signal?: AbortSignal) =>
	new Response(
		new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(
					frame({ choices: [{ delta: { reasoning_content: 'hmm, ' }, finish_reason: null }] }),
				);
				signal?.addEventListener('abort', () =>
					c.error(new DOMException('This operation was aborted', 'AbortError')),
				);
			},
		}),
		{ status: 200 },
	);
const textThenHang = (signal?: AbortSignal) =>
	new Response(
		new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(
					frame({ choices: [{ delta: { content: 'hey, how did ' }, finish_reason: null }] }),
				);
				signal?.addEventListener('abort', () =>
					c.error(new DOMException('This operation was aborted', 'AbortError')),
				);
			},
		}),
		{ status: 200 },
	);
const reply = () =>
	new Response(
		new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(frame({ choices: [{ delta: { content: 'sure!' }, finish_reason: null }] }));
				c.enqueue(frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
				c.enqueue(enc.encode('data: [DONE]\n\n'));
				c.close();
			},
		}),
		{ status: 200 },
	);

function send(convId: string, userId: string, text: string) {
	const url = new URL(`http://x/api/conversations/${convId}/messages?stream=1`);
	return POST({
		locals: { user: { id: userId, role: 'admin' } },
		params: { id: convId },
		url,
		request: new Request(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ text }),
		}),
	} as unknown as Parameters<typeof POST>[0]);
}

function seedThread(checkIns: boolean) {
	const u = seedUser();
	const conv = createConversation({
		userId: u.id,
		endpointId: 'mock',
		modelId: 'mock::m',
		modelKind: 'chat',
		replyStyle: 'character',
		checkIns,
	});
	const first = appendMessage({
		conversationId: conv.id,
		parentMessageId: null,
		role: 'user',
		parts: [{ type: 'text', text: 'heading out' }],
	});
	const answer = appendMessage({
		conversationId: conv.id,
		parentMessageId: first.id,
		role: 'assistant',
		parts: [{ type: 'text', text: 'gtg, work\n\n[later 1h: ask how the meeting went]' }],
	});
	return { u, conv, first, answer };
}

function branchTexts(convId: string): string[] {
	return walkActiveBranch(convId).map((m) =>
		m.parts.map((p) => (p.type === 'text' ? p.text : `[${p.type}]`)).join(''),
	);
}

async function untilUpstreamCalled(n: number): Promise<void> {
	for (let i = 0; i < 100 && mocks.calls < n; i++) await new Promise((r) => setTimeout(r, 5));
	await new Promise((r) => setTimeout(r, 20));
}

it('keeps a message sent while a check-in turn is still reasoning', async () => {
	const { u, conv, first, answer } = seedThread(true);
	expect(scheduleCheckInFromReply(conv.id, u.id, answer, T0)).toBe(true);
	mocks.upstream.push(reasoningThenHang, reply);
	expect(await runCheckInSweep(T0 + HOUR)).toBe(1);
	await untilUpstreamCalled(1);
	const res = await send(conv.id, u.id, 'actually, quick question');
	await res.text();
	await idle(conv.id);
	const branch = walkActiveBranch(conv.id);
	expect(branch[0].id).toBe(first.id);
	expect(branchTexts(conv.id)).toContain('actually, quick question');
	expect(branchTexts(conv.id).at(-1)).toBe('sure!');
});

it('keeps a message sent after a check-in turn already wrote text', async () => {
	const { u, conv, first, answer } = seedThread(true);
	expect(scheduleCheckInFromReply(conv.id, u.id, answer, T0)).toBe(true);
	mocks.upstream.push(textThenHang, reply);
	expect(await runCheckInSweep(T0 + HOUR)).toBe(1);
	await untilUpstreamCalled(1);
	const res = await send(conv.id, u.id, 'actually, quick question');
	await res.text();
	await idle(conv.id);
	expect(walkActiveBranch(conv.id)[0].id).toBe(first.id);
	expect(branchTexts(conv.id)).toContain('actually, quick question');
});

it('keeps a superseding send on the branch when it is stopped before the upstream answers', async () => {
	const { u, conv, first } = seedThread(false);
	mocks.upstream.push(reasoningThenHang);
	const r1 = await send(conv.id, u.id, 'first question');
	void r1.text().catch(() => {});
	await untilUpstreamCalled(1);
	mocks.upstream.push(
		((signal?: AbortSignal) =>
			new Promise<Response>((_, rej) =>
				signal?.addEventListener('abort', () =>
					rej(new DOMException('This operation was aborted', 'AbortError')),
				),
			)) as unknown as (signal?: AbortSignal) => Response,
	);
	const r2 = await send(conv.id, u.id, 'second question');
	void r2.text().catch(() => {});
	await untilUpstreamCalled(2);
	await cancelInFlightGenerations(conv.id, { sparePhotos: true });
	await idle(conv.id);
	expect(walkActiveBranch(conv.id)[0].id).toBe(first.id);
	expect(branchTexts(conv.id)).toContain('second question');
});
