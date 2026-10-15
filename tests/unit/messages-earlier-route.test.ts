/**
 * GET /api/conversations/:id/messages — the chat page's "load earlier", on a
 * real (in-memory) database. Ownership comes from the conversation lookup,
 * since `messages` carries no user id.
 */
import type { RequestEvent } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, closeTestDb } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

import { GET } from '../../src/routes/api/conversations/[id]/messages/+server';
import { createConversation } from '#lib/server/db/queries/conversations.js';
import {
	appendMessage,
	BRANCH_WINDOW_SIZE,
	walkActiveBranch,
	walkActiveBranchWindow,
} from '#lib/server/db/queries/messages.js';
import type { EarlierMessagesResponse } from '#lib/types/api.js';

let owner: string;
let convId: string;

beforeEach(() => {
	createTestDb();
	owner = seedUser().id;
	convId = createConversation({
		userId: owner,
		endpointId: 'bridge',
		modelId: 'bridge::m',
		modelKind: 'chat',
	}).id;
	let parent: string | null = null;
	// Comfortably more than two windows.
	for (let i = 0; i < BRANCH_WINDOW_SIZE + 10; i++) {
		const q = appendMessage({
			conversationId: convId,
			parentMessageId: parent,
			role: 'user',
			parts: [{ type: 'text', text: `q${i}` }],
		});
		parent = appendMessage({
			conversationId: convId,
			parentMessageId: q.id,
			role: 'assistant',
			parts: [{ type: 'text', text: `a${i}` }],
		}).id;
	}
});
afterEach(() => closeTestDb());

async function get(query: string, userId = owner): Promise<Response> {
	const url = new URL(`https://chat.example.test/api/conversations/${convId}/messages?${query}`);
	try {
		return await GET({
			locals: { user: { id: userId } },
			params: { id: convId },
			url,
		} as unknown as RequestEvent<{ id: string }, '/api/conversations/[id]/messages'>);
	} catch (e) {
		if (e && typeof e === 'object' && 'status' in e)
			return new Response(null, { status: Number(e.status) });
		throw e;
	}
}

describe('GET /api/conversations/:id/messages', () => {
	it('returns the window before the cursor', async () => {
		const tail = walkActiveBranchWindow(convId, { limit: BRANCH_WINDOW_SIZE })!;
		const res = await get(`before=${tail.messages[0].id}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as EarlierMessagesResponse;
		expect(body.hasEarlier).toBe(true);
		const all = walkActiveBranch(convId).map((m) => m.id);
		const loaded = [...body.messages, ...tail.messages].map((m) => m.id);
		expect(loaded).toEqual(all.slice(-loaded.length));
	});

	it('loads back through a deep-linked message', async () => {
		const all = walkActiveBranch(convId).map((m) => m.id);
		const tail = walkActiveBranchWindow(convId, { limit: BRANCH_WINDOW_SIZE })!;
		const res = await get(`before=${tail.messages[0].id}&through=${all[0]}`);
		const body = (await res.json()) as EarlierMessagesResponse;
		expect(body.hasEarlier).toBe(false);
		expect(body.messages[0].id).toBe(all[0]);
	});

	it('answers 409 when the cursor is no longer on the active branch', async () => {
		expect((await get('before=not-on-this-branch')).status).toBe(409);
	});

	it("is a 404 to anyone but the conversation's owner", async () => {
		const tail = walkActiveBranchWindow(convId, { limit: BRANCH_WINDOW_SIZE })!;
		const stranger = seedUser().id;
		expect((await get(`before=${tail.messages[0].id}`, stranger)).status).toBe(404);
	});

	it('requires a cursor', async () => {
		expect((await get('')).status).toBe(400);
	});
});
