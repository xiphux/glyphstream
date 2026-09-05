/**
 * Compaction serializes its own upstream payload.
 *
 * `prepareCompaction` deliberately does NOT go through `serializeBranchForUpstream`
 * — that would re-trim around the very summary it's folding in — so it is the one
 * wire-message producer in the tree that `applyWireTransforms` never reaches. It
 * skips the two SIZE passes on purpose; it must not skip the VALIDITY repair.
 *
 * A branch can legitimately carry an assistant `tool_calls` whose answering
 * `tool` row isn't on it: an upstream that ended a turn without running tools, or
 * a leaf moved past a reaction's bookkeeping. Strict backends reject that, and
 * because compaction re-fires on every send once a thread is over its threshold,
 * the failure isn't one bad request — it's compaction permanently broken on
 * exactly the long threads that need it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';
import type { LoadedEndpoint } from '$lib/server/endpoints/config';

const ENDPOINT: LoadedEndpoint = {
	id: 'mock',
	displayName: 'Mock',
	baseUrl: 'http://localhost/v1',
	apiKey: null,
	requestTimeoutSeconds: 120,
	providerQuirk: 'passthrough',
	groupBy: 'endpoint',
	supportsTools: true,
	maxConcurrent: Infinity,
	resourceGroup: 'mock',
	resourceGroupMaxConcurrent: Infinity,
	release: null,
	contextWindow: null,
	modelContextWindows: {},
	modelPromptStyles: {},
	modelPromptHints: {},
};

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB }));

vi.mock('$lib/server/db/client', () => ({
	getDb: () => mocks.testDb,
	closeDb: () => {},
}));
vi.mock('$lib/server/endpoints/registry', () => ({
	getEndpoint: () => ENDPOINT,
}));
vi.mock('$lib/server/endpoints/list-models', () => ({
	listAllModels: async () => [],
}));

import { prepareCompaction } from '$lib/server/chat/compaction';
import { createConversation } from '$lib/server/db/queries/conversations';
import { appendMessage } from '$lib/server/db/queries/messages';

beforeEach(() => {
	mocks.testDb = createTestDb();
});
afterEach(() => closeTestDb());

/** A thread long enough to be past `keepTurns`, whose FIRST turn carries an
 *  assistant `tool_call` with no answering `tool` row on the branch. */
function seedBranchWithOrphan(): { conversationId: string; userId: string } {
	const u = seedUser();
	const conv = createConversation({
		userId: u.id,
		endpointId: 'mock',
		modelId: 'mock::mock-chat',
		modelKind: 'chat',
	});
	let parent: string | null = null;
	const add = (role: 'user' | 'assistant', parts: Parameters<typeof appendMessage>[0]['parts']) => {
		const m = appendMessage({
			conversationId: conv.id,
			parentMessageId: parent,
			role,
			parts,
			contentHtml: null,
			reasoningText: null,
			finishReason: null,
			modelUsed: null,
			tokensIn: null,
			tokensOut: null,
		});
		parent = m.id;
		return m;
	};

	add('user', [{ type: 'text', text: 'I got the job!!' }]);
	// The orphan: a reaction call whose `tool` row is not on this branch.
	add('assistant', [
		{ type: 'text', text: 'Congratulations!' },
		{
			type: 'tool_call',
			toolCallId: 'call_r',
			toolName: 'react_to_message',
			arguments: '{"emoji":"🎉"}',
		},
	]);
	// Enough further turns that the orphan lands inside the folded slice.
	for (let i = 0; i < 8; i++) {
		add('user', [{ type: 'text', text: `turn ${i}` }]);
		add('assistant', [{ type: 'text', text: `reply ${i}` }]);
	}
	return { conversationId: conv.id, userId: u.id };
}

describe('prepareCompaction', () => {
	it('strips an unanswered tool_call from the summarization payload', async () => {
		const { conversationId, userId } = seedBranchWithOrphan();

		const plan = await prepareCompaction(conversationId, userId, { keepTurns: 2 });

		expect(plan).not.toBeNull();
		const carrying = plan!.messages.filter((m) => m.tool_calls);
		expect(carrying).toEqual([]);
		// The turn itself is still folded in — only the unanswerable call is gone.
		expect(plan!.messages.some((m) => m.content === 'Congratulations!')).toBe(true);
	});

	it('keeps a tool_call the branch does answer', async () => {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'mock',
			modelId: 'mock::mock-chat',
			modelKind: 'chat',
		});
		let parent: string | null = null;
		const add = (
			role: 'user' | 'assistant' | 'tool',
			parts: Parameters<typeof appendMessage>[0]['parts'],
		) => {
			const m = appendMessage({
				conversationId: conv.id,
				parentMessageId: parent,
				role,
				parts,
				contentHtml: null,
				reasoningText: null,
				finishReason: null,
				modelUsed: null,
				tokensIn: null,
				tokensOut: null,
			});
			parent = m.id;
			return m;
		};

		add('user', [{ type: 'text', text: 'what time is it' }]);
		add('assistant', [
			{ type: 'text', text: 'Let me check.' },
			{ type: 'tool_call', toolCallId: 'call_t', toolName: 'get_current_time', arguments: '{}' },
		]);
		add('tool', [{ type: 'tool_result', toolCallId: 'call_t', result: '{"iso":"now"}' }]);
		add('assistant', [{ type: 'text', text: "It's now." }]);
		for (let i = 0; i < 8; i++) {
			add('user', [{ type: 'text', text: `turn ${i}` }]);
			add('assistant', [{ type: 'text', text: `reply ${i}` }]);
		}

		const plan = await prepareCompaction(conv.id, u.id, { keepTurns: 2 });

		expect(plan).not.toBeNull();
		const ids = plan!.messages.flatMap((m) => m.tool_calls?.map((c) => c.id) ?? []);
		expect(ids).toEqual(['call_t']);
	});
});
