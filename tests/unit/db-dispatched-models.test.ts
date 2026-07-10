/**
 * `messages.dispatched_models` — the durable record of the model set a prompt
 * was dispatched to, read back by the "New chat from this prompt" action.
 *
 * The point of the column is that it survives things that destroy the replies.
 * Inspecting the assistant siblings' `model_used` instead cannot work: a
 * discarded fan-out result is hard-deleted, and a retry appends a sibling that
 * is structurally identical to a second branch. Both are covered here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB }));
vi.mock('$lib/server/db/client', () => ({ getDb: () => mocks.testDb, closeDb: () => {} }));

import { createConversation } from '$lib/server/db/queries/conversations';
import {
	appendMessage,
	deleteBranch,
	getSiblingAssistants,
	walkActiveBranch,
} from '$lib/server/db/queries/messages';
import type { CompareSelection } from '$lib/fanout';

beforeEach(() => {
	mocks.testDb = createTestDb();
});
afterEach(() => closeTestDb());

const CART: CompareSelection[] = [
	{ modelId: 'bridge::sdxl', count: 1 },
	{ modelId: 'bridge::flux', count: 1 },
	{ modelId: 'bridge::pony', count: 1 },
];

/** A fan-out as the server writes it: one user message carrying the whole cart,
 *  N sibling assistants pinned under it (advanceActiveLeaf:false). */
function seedFanout(userId: string, dispatchedModels?: CompareSelection[]) {
	const conv = createConversation({
		userId,
		endpointId: 'bridge',
		modelId: 'bridge::sdxl',
		modelKind: 'image',
		title: 'T',
	});
	const user = appendMessage({
		conversationId: conv.id,
		parentMessageId: null,
		role: 'user',
		parts: [{ type: 'text', text: 'a cat' }],
		dispatchedModels,
	});
	const branches = CART.map((m) =>
		appendMessage({
			conversationId: conv.id,
			parentMessageId: user.id,
			role: 'assistant',
			parts: [{ type: 'text', text: `from ${m.modelId}` }],
			modelUsed: m.modelId,
			advanceActiveLeaf: false,
		}),
	);
	return { convId: conv.id, userId: user.id, branches };
}

/** The user message as the client sees it. While a fan-out is parked the active
 *  leaf stays pinned here, so the walk returns just this row — the sibling
 *  assistants hang off it and are read via getSiblingAssistants. */
function userRow(convId: string) {
	return walkActiveBranch(convId).find((m) => m.role === 'user');
}

describe('dispatched_models round-trip', () => {
	it('surfaces the recorded cart on the user message', () => {
		const u = seedUser();
		const { convId } = seedFanout(u.id, CART);
		expect(userRow(convId)?.dispatchedModels).toEqual(CART);
	});

	it('preserves a same-model ×N count', () => {
		const u = seedUser();
		const cart = [{ modelId: 'bridge::sdxl', count: 3 }];
		const { convId } = seedFanout(u.id, cart);
		expect(userRow(convId)?.dispatchedModels).toEqual(cart);
	});

	it('omits the field on assistant rows', () => {
		const u = seedUser();
		const { convId, userId } = seedFanout(u.id, CART);
		const assistants = getSiblingAssistants(convId, userId);
		expect(assistants).toHaveLength(3);
		expect(assistants.every((m) => m.dispatchedModels === undefined)).toBe(true);
	});

	it('leaves the field undefined on rows predating the column', () => {
		const u = seedUser();
		const { convId } = seedFanout(u.id, undefined);
		expect(userRow(convId)?.dispatchedModels).toBeUndefined();
	});
});

describe('survives the loss of the replies it describes', () => {
	// The bug this column exists to fix: kicking off a multi-image generation and
	// pruning the results you didn't like is the normal workflow, and deleteBranch
	// hard-deletes those rows.
	it('still reports all three models after two branches are discarded', () => {
		const u = seedUser();
		const { convId, userId, branches } = seedFanout(u.id, CART);

		expect(deleteBranch(convId, branches[1].id, u.id)).toMatchObject({
			deletedIds: [branches[1].id],
		});
		expect(deleteBranch(convId, branches[2].id, u.id)).toMatchObject({
			deletedIds: [branches[2].id],
		});

		// Only one reply left, but the prompt still knows it ran against three.
		const remaining = getSiblingAssistants(convId, userId);
		expect(remaining.map((m) => m.modelUsed)).toEqual(['bridge::sdxl']);
		expect(userRow(convId)?.dispatchedModels).toEqual(CART);
	});

	// A retry appends another assistant under the same user message. Counting
	// siblings would read this as a two-model fan-out; the record doesn't move.
	it('is unchanged by a retry appending another sibling', () => {
		const u = seedUser();
		const single: CompareSelection[] = [{ modelId: 'bridge::sdxl', count: 1 }];
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::sdxl',
			modelKind: 'chat',
			title: 'T',
		});
		const user = appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'user',
			parts: [{ type: 'text', text: 'hi' }],
			dispatchedModels: single,
		});
		appendMessage({
			conversationId: conv.id,
			parentMessageId: user.id,
			role: 'assistant',
			parts: [{ type: 'text', text: 'first' }],
			modelUsed: 'bridge::sdxl',
		});
		// The retry: same parent, a different model picked in the picker.
		appendMessage({
			conversationId: conv.id,
			parentMessageId: user.id,
			role: 'assistant',
			parts: [{ type: 'text', text: 'second' }],
			modelUsed: 'bridge::flux',
		});

		const row = walkActiveBranch(conv.id).find((m) => m.role === 'user');
		expect(row?.siblingIds).toBeDefined();
		expect(row?.dispatchedModels).toEqual(single);
	});
});
