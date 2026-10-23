/**
 * `GET /api/conversations/:id?fanout=1&have=` — the fan-out poll downloads each
 * finished branch once. A branch is named by its id and a hash of its content,
 * so one that changes after landing is sent again instead of being rebuilt from
 * the poller's stale copy.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ConversationRecoveryPoll, FanoutRecoveryState } from '#lib/types/api.js';

const mocks = vi.hoisted(() => ({ siblings: [] as ChatMessage[] }));
vi.mock('#lib/server/auth/guard.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/auth/guard.js')>()),
	requireUser: () => {},
}));
vi.mock('#lib/server/db/queries/conversations.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/db/queries/conversations.js')>()),
	getConversationMeta: () => ({ activeLeafMessageId: 'u1' }),
}));
vi.mock('#lib/server/messages/fanout-recovery.js', () => ({
	getFanoutRecoveryState: (): FanoutRecoveryState => ({
		parentMessageId: 'u1',
		avatar: false,
		kind: 'chat',
		siblings: mocks.siblings,
		pending: 1,
		pendingModelIds: [''],
		pendingStartedAt: [null],
		pendingSourceMediaIds: [null],
	}),
}));

import { GET } from '../../src/routes/api/conversations/[id]/+server';

function sibling(id: string, html: string): ChatMessage {
	return {
		id,
		role: 'assistant',
		parts: [{ type: 'text', text: html }],
		contentHtml: `<p>${html}</p>`,
		reasoningText: null,
		finishReason: 'stop',
		modelUsed: 'ep::m',
		tokensIn: null,
		tokensOut: null,
		genMs: null,
		createdAt: 1,
	};
}

async function poll(have?: string[]): Promise<ConversationRecoveryPoll> {
	const url = new URL(
		`http://x/api/conversations/c1?fanout=1${have ? `&have=${have.join(',')}` : ''}`,
	);
	const res = await GET({
		locals: { user: { id: 'u' } },
		params: { id: 'c1' },
		url,
	} as unknown as Parameters<typeof GET>[0]);
	return (await res.json()) as ConversationRecoveryPoll;
}

beforeEach(() => {
	mocks.siblings = [sibling('a', 'one'), sibling('b', 'two')];
});

describe('GET /api/conversations/:id?fanout=1', () => {
	it('sends every branch, keyed, when the poller holds none', async () => {
		const body = await poll();
		expect(body.fanout.siblings.map((m) => m.id)).toEqual(['a', 'b']);
		expect(body.siblingKeys).toHaveLength(2);
		expect(body.siblingKeys[0]).toMatch(/^a\.[\w-]+$/);
	});

	it('leaves out the branches named in have=, keeping every key', async () => {
		const { siblingKeys } = await poll();
		const body = await poll([siblingKeys[0]]);
		expect(body.fanout.siblings.map((m) => m.id)).toEqual(['b']);
		expect(body.siblingKeys).toEqual(siblingKeys);
	});

	it('sends a held branch again once its content has changed', async () => {
		const { siblingKeys } = await poll();
		mocks.siblings[0] = sibling('a', 'one, edited');
		const body = await poll(siblingKeys);
		expect(body.fanout.siblings.map((m) => m.id)).toEqual(['a']);
		expect(body.siblingKeys[0]).not.toBe(siblingKeys[0]);
		expect(body.siblingKeys[1]).toBe(siblingKeys[1]);
	});
});
