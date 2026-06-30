/**
 * Integration tests for the streaming compaction relay. Real test DB + a mocked
 * `chatCompletionStream` (canned SSE), so we can assert the full
 * stream-summary → persist-anchor flow deterministically — including the
 * discard-on-empty and discard-on-abort safety rules that protect against ever
 * writing a partial anchor.
 *
 * Modeled on relay-tool-loop.test.ts / video-relay.test.ts.
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

import { createConversation } from '$lib/server/db/queries/conversations';
import { appendMessage, walkActiveBranch } from '$lib/server/db/queries/messages';
import { streamCompaction } from '$lib/server/streaming/compaction-relay';
import type { CompactionPlan } from '$lib/server/chat/compaction';
import type { LoadedEndpoint } from '$lib/server/endpoints/config';
import type { ChatMessage, StreamEvent } from '$lib/types/api';

beforeEach(() => {
	mocks.testDb = createTestDb();
	mocks.upstreamResponses = [];
	mocks.upstreamCalls = [];
});

afterEach(() => {
	closeTestDb();
});

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
	contextWindow: null,
	modelContextWindows: {},
	modelPromptStyles: {},
	modelPromptHints: {},
};

function textChunk(text: string): string {
	return JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] });
}
function finishChunk(reason: string): string {
	return JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] });
}

/** A Response whose body streams the given SSE records, then [DONE]. */
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

/** A Response that streams one chunk then errors as an abort (Stop / disconnect). */
function abortingResponse(): Response {
	const enc = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(enc.encode(`data: ${textChunk('partial sum')}\n\n`));
			controller.error(new DOMException('aborted', 'AbortError'));
		},
	});
	return new Response(stream, { status: 200 });
}

async function drainEvents(stream: ReadableStream<Uint8Array>): Promise<StreamEvent[]> {
	const events: StreamEvent[] = [];
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
			const data = frame
				.split('\n')
				.filter((l) => l.startsWith('data: '))
				.map((l) => l.slice(6))
				.join('\n');
			if (data) {
				try {
					events.push(JSON.parse(data) as StreamEvent);
				} catch {
					/* ignore */
				}
			}
			idx = buf.indexOf('\n\n');
		}
	}
	return events;
}

/** Seed a conversation with one user + one assistant turn; return ids. */
function seedBranch(): { conversationId: string; userMsg: ChatMessage; leaf: ChatMessage } {
	const u = seedUser();
	const conv = createConversation({
		userId: u.id,
		endpointId: 'bridge',
		modelId: 'bridge::mock',
		modelKind: 'chat',
	});
	const userMsg = appendMessage({
		conversationId: conv.id,
		parentMessageId: null,
		role: 'user',
		parts: [{ type: 'text', text: 'hello' }],
	});
	const leaf = appendMessage({
		conversationId: conv.id,
		parentMessageId: userMsg.id,
		role: 'assistant',
		parts: [{ type: 'text', text: 'hi there' }],
		tokensIn: 100,
		tokensOut: 20,
	});
	return { conversationId: conv.id, userMsg, leaf };
}

function planFor(opts: { resumeMessageId: string; parentLeafId: string }): CompactionPlan {
	return {
		endpoint,
		upstreamId: 'mock',
		providerQuirk: 'passthrough',
		storedModelId: 'bridge::mock',
		messages: [
			{ role: 'system', content: 'summarize' },
			{ role: 'user', content: 'go' },
		],
		resumeMessageId: opts.resumeMessageId,
		parentLeafId: opts.parentLeafId,
		maxTokens: 1024,
		temperature: 0.3,
	};
}

describe('streamCompaction', () => {
	it('streams the summary and persists the anchor on clean completion', async () => {
		const { conversationId, userMsg, leaf } = seedBranch();
		mocks.upstreamResponses = [
			() =>
				sseResponse([
					textChunk('Earlier, '),
					textChunk('the user said hello.'),
					finishChunk('stop'),
				]),
		];

		const events = await drainEvents(
			streamCompaction({
				conversationId,
				plan: planFor({ resumeMessageId: userMsg.id, parentLeafId: leaf.id }),
			}),
		);

		const types = events.map((e) => e.type);
		expect(types[0]).toBe('compaction_start');
		expect(types).toContain('compaction_text');
		expect(types).toContain('compaction_done');
		expect(types).not.toContain('error');

		// Concatenated text deltas == the streamed summary.
		const streamed = events
			.filter(
				(e): e is Extract<StreamEvent, { type: 'compaction_text' }> => e.type === 'compaction_text',
			)
			.map((e) => e.chunk)
			.join('');
		expect(streamed).toBe('Earlier, the user said hello.');

		// The done event carries the persisted anchor, marked + resuming correctly.
		const done = events.find(
			(e): e is Extract<StreamEvent, { type: 'compaction_done' }> => e.type === 'compaction_done',
		)!;
		expect(done.summaryMessage.role).toBe('assistant');
		expect(done.summaryMessage.compactionResumeFromMessageId).toBe(userMsg.id);

		// walkActiveBranch follows the active leaf, so the summary being its last
		// element proves both persistence at the leaf and the leaf advancing to it.
		const branch = walkActiveBranch(conversationId);
		const last = branch[branch.length - 1];
		expect(last.id).toBe(done.summaryMessage.id);
		expect(last.compactionResumeFromMessageId).toBe(userMsg.id);
		expect(last.contentHtml).toBeTruthy(); // markdown rendered
	});

	it('discards an empty summary — emits error, persists nothing, leaf unchanged', async () => {
		const { conversationId, userMsg, leaf } = seedBranch();
		const before = walkActiveBranch(conversationId).length;
		mocks.upstreamResponses = [() => sseResponse([finishChunk('stop')])]; // no text at all

		const events = await drainEvents(
			streamCompaction({
				conversationId,
				plan: planFor({ resumeMessageId: userMsg.id, parentLeafId: leaf.id }),
			}),
		);

		const err = events.find(
			(e): e is Extract<StreamEvent, { type: 'error' }> => e.type === 'error',
		);
		expect(err?.message).toMatch(/empty summary/i);
		expect(events.some((e) => e.type === 'compaction_done')).toBe(false);

		// Nothing appended, leaf still the original assistant.
		const branch = walkActiveBranch(conversationId);
		expect(branch.length).toBe(before);
		expect(branch[branch.length - 1].id).toBe(leaf.id);
	});

	it('reports an output-limit (length) empty completion distinctly from a bare empty one', async () => {
		const { conversationId, userMsg, leaf } = seedBranch();
		const before = walkActiveBranch(conversationId).length;
		// No text deltas, finishes on `length` — the reasoning-ate-the-budget case.
		mocks.upstreamResponses = [() => sseResponse([finishChunk('length')])];

		const events = await drainEvents(
			streamCompaction({
				conversationId,
				plan: planFor({ resumeMessageId: userMsg.id, parentLeafId: leaf.id }),
			}),
		);

		const err = events.find(
			(e): e is Extract<StreamEvent, { type: 'error' }> => e.type === 'error',
		);
		expect(err?.message).toMatch(/output limit/i);
		expect(err?.message).not.toMatch(/empty summary/i);
		expect(events.some((e) => e.type === 'compaction_done')).toBe(false);
		// Still discarded — nothing persisted, leaf unchanged.
		const branch = walkActiveBranch(conversationId);
		expect(branch.length).toBe(before);
		expect(branch[branch.length - 1].id).toBe(leaf.id);
	});

	it('discards a cancelled stream — distinct message, persists nothing', async () => {
		const { conversationId, userMsg, leaf } = seedBranch();
		const before = walkActiveBranch(conversationId).length;
		mocks.upstreamResponses = [() => abortingResponse()];

		const events = await drainEvents(
			streamCompaction({
				conversationId,
				plan: planFor({ resumeMessageId: userMsg.id, parentLeafId: leaf.id }),
			}),
		);

		const err = events.find(
			(e): e is Extract<StreamEvent, { type: 'error' }> => e.type === 'error',
		);
		expect(err?.message).toMatch(/cancelled/i);
		expect(events.some((e) => e.type === 'compaction_done')).toBe(false);
		expect(walkActiveBranch(conversationId).length).toBe(before);
	});
});
