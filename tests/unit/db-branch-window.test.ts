/**
 * The chat page loads a window of the active branch rather than all of it:
 * the newest messages first, then older ones on demand. A window always starts
 * on a user message, so a turn is never split across two loads.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB }));
vi.mock('#lib/server/db/client.js', () => ({ getDb: () => mocks.testDb, closeDb: () => {} }));

import { createConversation } from '#lib/server/db/queries/conversations.js';
import {
	appendMessage,
	branchWindowBounds,
	walkActiveBranch,
	walkActiveBranchWindow,
} from '#lib/server/db/queries/messages.js';

beforeEach(() => {
	mocks.testDb = createTestDb();
});
afterEach(() => closeTestDb());

/** A leaf → root branch from a root → leaf role string: u=user, a=assistant, t=tool. */
function branch(roles: string) {
	const names = { u: 'user', a: 'assistant', t: 'tool' } as Record<string, string>;
	return [...roles].map((r, i) => ({ id: `m${i}`, role: names[r] })).reverse();
}

describe('branchWindowBounds', () => {
	it('takes the newest messages, snapped back to a user message', () => {
		// root→leaf: u a t a | u a — a limit of 3 lands mid-turn (on `t`), so the
		// window grows back to that turn's user message.
		const b = branch('uataua');
		expect(branchWindowBounds(b, { limit: 2 })).toEqual({ start: 0, end: 2 });
		expect(branchWindowBounds(b, { limit: 3 })).toEqual({ start: 0, end: 6 });
	});

	it('takes the messages before a cursor', () => {
		const b = branch('uauaua'); // leaf→root ids: m5..m0
		expect(branchWindowBounds(b, { limit: 2, before: 'm4' })).toEqual({ start: 2, end: 4 });
	});

	it('loads back through a target, however far', () => {
		const b = branch('uauauaua');
		expect(branchWindowBounds(b, { limit: 2, before: 'm6', through: 'm1' })).toEqual({
			start: 2,
			end: 8,
		});
	});

	it('refuses a cursor that is not on the branch, or a target newer than it', () => {
		const b = branch('uaua');
		expect(branchWindowBounds(b, { limit: 2, before: 'elsewhere' })).toBeNull();
		expect(branchWindowBounds(b, { limit: 2, before: 'm1', through: 'm3' })).toBeNull();
	});

	it('returns an empty window past the root', () => {
		const b = branch('ua');
		expect(branchWindowBounds(b, { limit: 2, before: 'm0' })).toEqual({ start: 2, end: 2 });
	});
});

describe('walkActiveBranchWindow', () => {
	function thread(turns: number) {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::m',
			modelKind: 'chat',
		});
		let parent: string | null = null;
		for (let i = 0; i < turns; i++) {
			const q = appendMessage({
				conversationId: conv.id,
				parentMessageId: parent,
				role: 'user',
				parts: [{ type: 'text', text: `q${i}` }],
			});
			const a = appendMessage({
				conversationId: conv.id,
				parentMessageId: q.id,
				role: 'assistant',
				parts: [{ type: 'text', text: `a${i}` }],
				contentHtml: `<p>a${i}</p>`,
			});
			parent = a.id;
		}
		return conv.id;
	}

	it('pages through the whole branch, newest first, with nothing lost or repeated', () => {
		const id = thread(7); // 14 messages
		const all = walkActiveBranch(id).map((m) => m.id);
		const first = walkActiveBranchWindow(id, { limit: 6 })!;
		expect(first.hasEarlier).toBe(true);
		expect(first.messages.map((m) => m.id)).toEqual(all.slice(-6));
		expect(first.messages[0].role).toBe('user');

		let loaded = first.messages.map((m) => m.id);
		let hasEarlier = first.hasEarlier;
		while (hasEarlier) {
			const page = walkActiveBranchWindow(id, { limit: 6, before: loaded[0] })!;
			loaded = [...page.messages.map((m) => m.id), ...loaded];
			hasEarlier = page.hasEarlier;
		}
		expect(loaded).toEqual(all);
	});

	it('carries the rendered HTML and sibling data for the window', () => {
		const id = thread(3);
		const w = walkActiveBranchWindow(id, { limit: 2 })!;
		expect(w.messages[1]).toMatchObject({ contentHtml: '<p>a2</p>', siblingCount: 1 });
	});

	it('loads back through a deep-linked message in one request', () => {
		const id = thread(10);
		const all = walkActiveBranch(id).map((m) => m.id);
		const tail = walkActiveBranchWindow(id, { limit: 4 })!;
		const back = walkActiveBranchWindow(id, {
			limit: 4,
			before: tail.messages[0].id,
			through: all[3],
		})!;
		// all[3] is an assistant reply; the window starts at its turn's question.
		expect(back.messages[0].id).toBe(all[2]);
		expect([...back.messages, ...tail.messages].map((m) => m.id)).toEqual(all.slice(2));
	});

	it('answers null when the cursor is no longer on the active branch', () => {
		const id = thread(3);
		expect(walkActiveBranchWindow(id, { limit: 4, before: 'gone' })).toBeNull();
	});

	it('is empty for a conversation with no messages yet', () => {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::m',
			modelKind: 'chat',
		});
		expect(walkActiveBranchWindow(conv.id, { limit: 4 })).toEqual({
			messages: [],
			hasEarlier: false,
		});
	});
});
