/**
 * Texting check-ins end to end: a reply's `[later …]` marker becomes a pending
 * row, the runner fires it as a real chat turn (the relay is real; only the
 * upstream and push are stubbed), and every reason not to fire — the user
 * answered, something is running, it's too late — is honoured.
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
	testDb: null as unknown as TestDB,
	upstream: [] as Array<() => Response>,
	upstreamBodies: [] as Array<{ messages: Array<{ role: string; content: unknown }> }>,
	enabled: true,
}));

vi.mock('#lib/server/endpoints/client.js', async (orig) => ({
	...(await orig<typeof import('#lib/server/endpoints/client.js')>()),
	chatCompletionStream: vi.fn(
		async (_endpoint: unknown, body: (typeof mocks.upstreamBodies)[0]) => {
			mocks.upstreamBodies.push(body);
			const next = mocks.upstream.shift();
			if (!next) throw new Error('no canned upstream response left');
			return next();
		},
	),
}));
vi.mock('#lib/server/endpoints/registry.js', () => ({
	getEndpoint: (id: string) => (id === 'mock' ? ENDPOINT : undefined),
}));
vi.mock('#lib/server/endpoints/list-models.js', () => ({
	listAllModels: async () => [{ endpointId: 'mock', upstreamId: 'm', supportsTools: false }],
}));
vi.mock('#lib/server/endpoints/config.js', async (orig) => ({
	...(await orig<typeof import('#lib/server/endpoints/config.js')>()),
	getCheckInsConfig: () => ({ enabled: mocks.enabled }),
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
}));

import { notifyConversationComplete } from '#lib/server/push/notify.js';
import { createConversation } from '#lib/server/db/queries/conversations.js';
import {
	appendMessage,
	getActiveLeafMessageId,
	walkActiveBranch,
} from '#lib/server/db/queries/messages.js';
import { getCheckIn, setCheckIn } from '#lib/server/db/queries/check-ins.js';
import { resetEndpointGatesForTests } from '#lib/server/endpoints/concurrency.js';
import { _resetForTests } from '#lib/server/tools/registry.js';
import {
	getInFlightSince,
	registerInFlight,
	resetInFlight,
} from '#lib/server/streaming/in-flight.js';
import { graceFor, reminderText, runCheckInSweep } from '#lib/server/check-ins/runner.js';
import { scheduleCheckInFromReply } from '#lib/server/check-ins/schedule.js';
import { isCheckInMessage } from '#lib/check-ins.js';
import { getDb } from '#lib/server/db/client.js';
import { users } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import type { ChatMessage, MessagePart } from '#lib/types/api.js';

const notify = vi.mocked(notifyConversationComplete);

function sse(records: object[]): Response {
	const enc = new TextEncoder();
	return new Response(
		new ReadableStream<Uint8Array>({
			start(c) {
				for (const r of records) c.enqueue(enc.encode(`data: ${JSON.stringify(r)}\n\n`));
				c.enqueue(enc.encode('data: [DONE]\n\n'));
				c.close();
			},
		}),
		{ status: 200 },
	);
}
const reply = (text: string) => () =>
	sse([
		{ choices: [{ delta: { content: text }, finish_reason: null }] },
		{ choices: [{ delta: {}, finish_reason: 'stop' }] },
	]);

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 27, 15, 0);

function thread(
	replyText = 'gtg, work\n\n[later 1h: ask how the meeting went]',
	style: 'texting' | 'standard' = 'texting',
	checkIns = true,
) {
	const u = seedUser();
	const conv = createConversation({
		userId: u.id,
		endpointId: 'mock',
		modelId: 'mock::m',
		modelKind: 'chat',
		replyStyle: style,
		checkIns,
	});
	const user = appendMessage({
		conversationId: conv.id,
		parentMessageId: null,
		role: 'user',
		parts: [{ type: 'text', text: 'heading out' }],
	});
	const answer = appendMessage({
		conversationId: conv.id,
		parentMessageId: user.id,
		role: 'assistant',
		parts: [{ type: 'text', text: replyText }],
	});
	return { userId: u.id, conversationId: conv.id, user, answer };
}

/** The thread's pending check-in, set the way a finished turn sets it. */
function scheduled(t: ReturnType<typeof thread>, now = T0) {
	expect(scheduleCheckInFromReply(t.conversationId, t.userId, t.answer, now)).toBe(true);
	return getCheckIn(t.conversationId, t.userId)!;
}

async function idle(conversationId: string): Promise<void> {
	for (let i = 0; i < 200; i++) {
		if (getInFlightSince(conversationId) === null) {
			// The outcome (and its settle) runs a beat after the entry clears.
			await new Promise((r) => setTimeout(r, 20));
			return;
		}
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error('turn never finished');
}

const roles = (branch: ChatMessage[]) =>
	branch.map((m) => (isCheckInMessage(m) ? 'check-in' : m.role));
const text = (m: ChatMessage) =>
	(m.parts[0] as Extract<MessagePart, { type: 'text' }> | undefined)?.text;

beforeEach(() => {
	mocks.testDb = createTestDb();
	mocks.upstream = [];
	mocks.upstreamBodies = [];
	mocks.enabled = true;
	notify.mockClear();
	_resetForTests();
});
afterEach(() => {
	closeTestDb();
	resetInFlight();
	resetEndpointGatesForTests();
	_resetForTests();
});

describe('scheduling', () => {
	it('sets a check-in from the last marker, an hour out', () => {
		const t = thread();
		expect(scheduled(t)).toEqual({
			sourceMessageId: t.answer.id,
			fireAt: T0 + HOUR,
			note: 'ask how the meeting went',
		});
	});

	it('clears the old one when a reply sets none', () => {
		const t = thread();
		scheduled(t);
		const next = appendMessage({
			conversationId: t.conversationId,
			parentMessageId: t.answer.id,
			role: 'assistant',
			parts: [{ type: 'text', text: 'actually nvm' }],
		});
		expect(scheduleCheckInFromReply(t.conversationId, t.userId, next, T0)).toBe(false);
		expect(getCheckIn(t.conversationId, t.userId)).toBeNull();
	});

	it('sets nothing while turned off', () => {
		mocks.enabled = false;
		const t = thread();
		expect(scheduleCheckInFromReply(t.conversationId, t.userId, t.answer, T0)).toBe(false);
	});
});

describe('firing', () => {
	it('texts out of the blue: a reminder in the user’s place, a reply, a notification', async () => {
		const t = thread();
		scheduled(t);
		mocks.upstream.push(reply('so how did it go??'));

		expect(await runCheckInSweep(T0 + HOUR)).toBe(1);
		await idle(t.conversationId);

		const branch = walkActiveBranch(t.conversationId);
		expect(roles(branch)).toEqual(['user', 'assistant', 'check-in', 'assistant']);
		expect(text(branch[2])).toContain('You meant to: ask how the meeting went.');
		expect(text(branch[3])).toBe('so how did it go??');
		// The model saw the reminder as the latest user turn.
		const sent = mocks.upstreamBodies[0].messages.at(-1)!;
		expect(sent).toMatchObject({ role: 'user', content: text(branch[2]) });
		expect(notify).toHaveBeenCalledWith(
			expect.objectContaining({
				conversationId: t.conversationId,
				assistantMessageId: branch[3].id,
				conversationTitle: 'm',
				previewText: 'so how did it go??',
			}),
		);
		expect(getCheckIn(t.conversationId, t.userId)).toBeNull();
	});

	it('waits for its time', async () => {
		const t = thread();
		scheduled(t);
		expect(await runCheckInSweep(T0 + HOUR - 1)).toBe(0);
		expect(getCheckIn(t.conversationId, t.userId)).not.toBeNull();
	});

	it('is dropped once the user has answered', async () => {
		const t = thread();
		scheduled(t);
		appendMessage({
			conversationId: t.conversationId,
			parentMessageId: t.answer.id,
			role: 'user',
			parts: [{ type: 'text', text: 'back!' }],
		});
		expect(await runCheckInSweep(T0 + HOUR)).toBe(0);
		expect(getCheckIn(t.conversationId, t.userId)).toBeNull();
		expect(mocks.upstreamBodies).toHaveLength(0);
	});

	it("is dropped in a conversation that can't check in", async () => {
		const t = thread(undefined, 'texting', false);
		scheduled(t);
		expect(await runCheckInSweep(T0 + HOUR)).toBe(0);
		expect(getCheckIn(t.conversationId, t.userId)).toBeNull();
	});

	it('reaches out in a standard conversation too, worded for one', async () => {
		const t = thread('Good luck!\n\n[later 1h: ask how the meeting went]', 'standard');
		scheduled(t);
		mocks.upstream.push(reply('How did the meeting go?'));
		expect(await runCheckInSweep(T0 + HOUR)).toBe(1);
		await idle(t.conversationId);
		const branch = walkActiveBranch(t.conversationId);
		expect(roles(branch)).toEqual(['user', 'assistant', 'check-in', 'assistant']);
		expect(text(branch[2])).toContain('since your last message');
		expect(text(branch[2])).toContain('Reach out now');
	});

	it('fires under a photo the reply sent', async () => {
		const t = thread();
		scheduled(t);
		const photo = appendMessage({
			conversationId: t.conversationId,
			parentMessageId: t.answer.id,
			role: 'assistant',
			parts: [
				{
					type: 'image',
					mediaId: 'media-1',
					displayOnly: true,
					photo: { sourceMessageId: t.answer.id, index: 0 },
				},
			],
		});
		mocks.upstream.push(reply('hey'));
		expect(await runCheckInSweep(T0 + HOUR)).toBe(1);
		await idle(t.conversationId);
		const branch = walkActiveBranch(t.conversationId);
		expect(branch[2].id).toBe(photo.id);
		expect(roles(branch).slice(3)).toEqual(['check-in', 'assistant']);
	});

	it('waits while something else runs, then gives up once too late', async () => {
		const t = thread();
		const row = scheduled(t);
		const busy = registerInFlight(t.conversationId, ENDPOINT);
		expect(await runCheckInSweep(T0 + HOUR)).toBe(0);
		expect(getCheckIn(t.conversationId, t.userId)).not.toBeNull();
		const grace = graceFor({ fireAt: row.fireAt, createdAt: T0 });
		expect(await runCheckInSweep(row.fireAt + grace + 1)).toBe(0);
		expect(getCheckIn(t.conversationId, t.userId)).toBeNull();
		busy.controller.abort();
	});

	it('takes a pass back out, as if it never fired', async () => {
		const t = thread();
		scheduled(t);
		mocks.upstream.push(reply('[no text]'));
		expect(await runCheckInSweep(T0 + HOUR)).toBe(1);
		await idle(t.conversationId);
		expect(roles(walkActiveBranch(t.conversationId))).toEqual(['user', 'assistant']);
		expect(getActiveLeafMessageId(t.conversationId, t.userId)).toBe(t.answer.id);
		expect(notify).not.toHaveBeenCalled();
	});

	it('lets a check-in set one more, but not a third in a row', async () => {
		const t = thread();
		scheduled(t);
		mocks.upstream.push(reply('u there?\n\n[later 2h: try once more]'));
		await runCheckInSweep(T0 + HOUR);
		await idle(t.conversationId);
		const second = getCheckIn(t.conversationId, t.userId);
		expect(second?.note).toBe('try once more');

		mocks.upstream.push(reply('ok goodnight\n\n[later 2h: again]'));
		await runCheckInSweep(second!.fireAt);
		await idle(t.conversationId);
		expect(roles(walkActiveBranch(t.conversationId))).toEqual([
			'user',
			'assistant',
			'check-in',
			'assistant',
			'check-in',
			'assistant',
		]);
		expect(getCheckIn(t.conversationId, t.userId)).toBeNull();
	});

	it('replaces, rather than adds to, a conversation’s check-in', () => {
		const t = thread();
		scheduled(t);
		setCheckIn({
			userId: t.userId,
			conversationId: t.conversationId,
			sourceMessageId: t.answer.id,
			note: 'other',
			fireAt: T0 + 2 * HOUR,
		});
		expect(getCheckIn(t.conversationId, t.userId)?.note).toBe('other');
	});
});

describe('fairness and accounts', () => {
	it("never fires a disabled account's check-in", async () => {
		const t = thread();
		scheduled(t);
		getDb().update(users).set({ disabledAt: T0 }).where(eq(users.id, t.userId)).run();
		expect(await runCheckInSweep(T0 + HOUR)).toBe(0);
		expect(mocks.upstreamBodies).toHaveLength(0);
	});

	it('reaches a due check-in behind a pile of waiting ones', async () => {
		const busy = [];
		for (let i = 0; i < 60; i++) {
			const w = thread();
			scheduled(w, T0 - 1);
			busy.push(registerInFlight(w.conversationId, ENDPOINT));
		}
		const t = thread();
		scheduled(t);
		mocks.upstream.push(reply('hey'));
		expect(await runCheckInSweep(T0 + HOUR)).toBe(1);
		await idle(t.conversationId);
		expect(roles(walkActiveBranch(t.conversationId)).at(-2)).toBe('check-in');
		for (const b of busy) b.controller.abort();
	});
});

describe('reminderText', () => {
	it('says when it is, how long it has been, and how to pass', () => {
		const at = Date.UTC(2026, 9, 27, 16, 0);
		expect(reminderText({ note: 'ask about work.', createdAt: at - 2 * HOUR }, at, 'UTC')).toBe(
			"(Check-in: it's Tuesday 4:00 PM, 2 hours since your last text, and they haven't replied. " +
				'You meant to: ask about work. Text them now if it still fits; if it no longer makes ' +
				'sense, reply with only [no text].)',
		);
	});
});
