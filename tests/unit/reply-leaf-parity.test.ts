/**
 * `resolveReplyLeaf` (server, parent-pointer walk over the DB) and
 * `lastReplyMessage` (client, index walk over the rendered branch) answer the
 * same question — "has the branch moved on past this reply, or is that just a
 * reaction's bookkeeping?" — by different mechanisms.
 *
 * They HAVE to agree. `canCompareAvatar` uses one and avatar `/prepare`'s
 * parkable rule uses the other, on either side of a single call: if the client
 * offers a comparison the server then refuses, the user finds out only after
 * picking their models, as a page-level error.
 *
 * Nothing structural enforces that — the two are separate implementations with
 * a comment asking them to match. This is the check. Every case is run through
 * BOTH, against a real DB for the server side, and asserted equal.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';
import type { ChatMessage, MessagePart } from '$lib/types/api';

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB }));
vi.mock('$lib/server/db/client', async (orig) => {
	const real = await orig<typeof import('$lib/server/db/client')>();
	return { ...real, getDb: () => mocks.testDb, closeDb: () => {} };
});

import { createConversation } from '$lib/server/db/queries/conversations';
import { appendMessage, resolveReplyLeaf } from '$lib/server/db/queries/messages';
import { lastReplyMessage } from '$lib/chat-render';

beforeEach(() => {
	mocks.testDb = createTestDb();
});
afterEach(() => closeTestDb());

const reaction = (id = 'call_r'): MessagePart => ({
	type: 'tool_call',
	toolCallId: id,
	toolName: 'react_to_message',
	arguments: '{"emoji":"🎉"}',
});
const realTool = (id = 'call_t'): MessagePart => ({
	type: 'tool_call',
	toolCallId: id,
	toolName: 'get_current_time',
	arguments: '{}',
});
const result = (id: string): MessagePart => ({ type: 'tool_result', toolCallId: id, result: 'ok' });
const text = (t: string): MessagePart => ({ type: 'text', text: t });

/** One branch shape, described as a linear chain of (role, parts). */
type Row = ['user' | 'assistant' | 'tool', MessagePart[]];

/** Persist the chain, then run BOTH implementations over it and return their
 *  answers as message ids so they're directly comparable. */
function bothAnswers(rows: Row[]): { server: string; client: string | undefined } {
	const u = seedUser();
	const conv = createConversation({
		userId: u.id,
		endpointId: 'e',
		modelId: 'e::m',
		modelKind: 'chat',
	});
	let parent: string | null = null;
	const persisted: ChatMessage[] = [];
	for (const [role, parts] of rows) {
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
		persisted.push(m);
	}
	const leaf = persisted[persisted.length - 1].id;
	return {
		server: resolveReplyLeaf(conv.id, leaf),
		client: lastReplyMessage(persisted)?.id,
	};
}

describe('resolveReplyLeaf / lastReplyMessage parity', () => {
	const cases: Array<[string, Row[]]> = [
		['a bare user message', [['user', [text('hi')]]]],
		[
			'an ordinary assistant leaf',
			[
				['user', [text('hi')]],
				['assistant', [text('hey')]],
			],
		],
		[
			'a reaction with its tool row — the case the helpers exist for',
			[
				['user', [text('I got the job!!')]],
				['assistant', [text('Congrats!'), reaction()]],
				['tool', [result('call_r')]],
			],
		],
		[
			'a reaction whose tool row is absent',
			[
				['user', [text('I got the job!!')]],
				['assistant', [text('Congrats!'), reaction()]],
			],
		],
		[
			'two stacked reaction tool rows',
			[
				['user', [text('hi')]],
				['assistant', [text('hey'), reaction('call_a'), reaction('call_b')]],
				['tool', [result('call_a')]],
				['tool', [result('call_b')]],
			],
		],
		[
			'a REAL tool call — must not be looked past',
			[
				['user', [text('what time is it')]],
				['assistant', [text(''), realTool()]],
				['tool', [result('call_t')]],
			],
		],
		[
			'a reaction alongside a real tool',
			[
				['user', [text('hi')]],
				['assistant', [text('hey'), reaction(), realTool()]],
				['tool', [result('call_t')]],
			],
		],
		[
			'a tool row under a NON-reaction assistant with no calls at all',
			[
				['user', [text('hi')]],
				['assistant', [text('hey')]],
				['tool', [result('call_x')]],
			],
		],
		[
			'a tool row directly under a user message',
			[
				['user', [text('hi')]],
				['tool', [result('call_x')]],
			],
		],
		[
			'a textless reaction — mid-loop shape',
			[
				['user', [text('I got the job!!')]],
				['assistant', [text(''), reaction()]],
				['tool', [result('call_r')]],
			],
		],
		[
			'a user turn after the reaction bookkeeping',
			[
				['user', [text('hi')]],
				['assistant', [text('hey'), reaction()]],
				['tool', [result('call_r')]],
				['user', [text('again')]],
			],
		],
	];

	it.each(cases)('agrees on %s', (_label, rows) => {
		const { server, client } = bothAnswers(rows);
		expect(client).toBe(server);
	});

	it('a root-level tool row is the one shape with no parent to walk to', () => {
		// Both must fall back to the leaf rather than walking off the end.
		const { server, client } = bothAnswers([['tool', [result('call_x')]]]);
		expect(client).toBe(server);
	});
});
