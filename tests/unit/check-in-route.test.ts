/**
 * GET / DELETE /api/conversations/:id/check-in — the open page's probe while a
 * check-in is due, and Cancel. Ownership comes from the conversation lookup.
 */
import type { RequestEvent } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({ enabled: true }));
vi.mock('#lib/server/endpoints/config.js', async (orig) => ({
	...(await orig<typeof import('#lib/server/endpoints/config.js')>()),
	getCheckInsConfig: () => ({ enabled: mocks.enabled }),
}));

import { DELETE, GET } from '../../src/routes/api/conversations/[id]/check-in/+server';
import { createConversation } from '#lib/server/db/queries/conversations.js';
import { appendMessage } from '#lib/server/db/queries/messages.js';
import { getCheckIn, setCheckIn } from '#lib/server/db/queries/check-ins.js';
import type { CheckInStatus } from '#lib/types/api.js';

let owner: string;
let convId: string;

beforeEach(() => {
	createTestDb();
	mocks.enabled = true;
	owner = seedUser().id;
	convId = createConversation({
		userId: owner,
		endpointId: 'bridge',
		modelId: 'bridge::m',
		modelKind: 'chat',
		replyStyle: 'texting',
		checkIns: true,
	}).id;
	const reply = appendMessage({
		conversationId: convId,
		parentMessageId: null,
		role: 'assistant',
		parts: [{ type: 'text', text: 'brb\n\n[later 1h: ask]' }],
	});
	setCheckIn({
		userId: owner,
		conversationId: convId,
		sourceMessageId: reply.id,
		note: 'ask',
		fireAt: 3_600_000,
		now: 0,
	});
});
afterEach(() => closeTestDb());

async function call(handler: typeof GET, userId = owner): Promise<Response> {
	try {
		return await handler({
			locals: { user: { id: userId } },
			params: { id: convId },
		} as unknown as RequestEvent<{ id: string }, '/api/conversations/[id]/check-in'>);
	} catch (e) {
		if (e && typeof e === 'object' && 'status' in e)
			return new Response(null, { status: Number(e.status) });
		throw e;
	}
}

describe('GET', () => {
	it('says what is pending', async () => {
		const body = (await (await call(GET)).json()) as CheckInStatus;
		expect(body).toMatchObject({ checkIn: { note: 'ask', fireAt: 3_600_000 } });
	});

	it('shows none while the operator has check-ins off', async () => {
		mocks.enabled = false;
		const body = (await (await call(GET)).json()) as CheckInStatus;
		expect(body.checkIn).toBeNull();
	});

	it("is a 404 for someone else's conversation", async () => {
		expect((await call(GET, seedUser().id)).status).toBe(404);
	});
});

describe('DELETE', () => {
	it('cancels it, for its owner only', async () => {
		expect((await call(DELETE, seedUser().id)).status).toBe(404);
		expect(getCheckIn(convId, owner)).not.toBeNull();
		expect(await (await call(DELETE)).json()).toEqual({ cancelled: true });
		expect(getCheckIn(convId, owner)).toBeNull();
	});
});
