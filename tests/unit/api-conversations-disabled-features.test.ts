/**
 * Route tests for the per-conversation `disabledFeatures` field on
 * POST /api/conversations and PATCH /api/conversations/:id: an unknown
 * category 400s rather than silently reading as "feature on", while every
 * built-in and any `mcp:` id (registered or not) is accepted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

vi.mock('#lib/server/endpoints/registry.js', () => ({
	getEndpoint: (id: string) => (id === 'mock' ? { id: 'mock' } : undefined),
}));

import { POST } from '../../src/routes/api/conversations/+server';
import { PATCH } from '../../src/routes/api/conversations/[id]/+server';
import { createConversation, getConversationMeta } from '#lib/server/db/queries/conversations.js';
import type { ConversationDetail } from '#lib/types/api.js';

function event(userId: string, method: string, body: unknown, params: Record<string, string> = {}) {
	return {
		locals: { user: { id: userId, role: 'user' } },
		params,
		request: new Request('http://x/api/conversations', {
			method,
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		}),
	} as never;
}

/** The status a handler answers with, whether it returns or throws. */
async function status(call: () => Response | Promise<Response>): Promise<number> {
	try {
		return (await call()).status;
	} catch (e) {
		return (e as { status: number }).status;
	}
}

let userId: string;
beforeEach(() => {
	createTestDb();
	userId = seedUser().id;
});
afterEach(() => closeTestDb());

describe('POST /api/conversations disabledFeatures', () => {
	it('rejects an unknown category', async () => {
		const body = { modelId: 'mock::chat', disabledFeatures: ['web', 'made-up-category'] };
		expect(await status(() => POST(event(userId, 'POST', body)))).toBe(400);
	});

	it('accepts built-ins and an unregistered mcp: id', async () => {
		const body = { modelId: 'mock::chat', disabledFeatures: ['web', 'reactions', 'mcp:gone'] };
		const res = await POST(event(userId, 'POST', body));
		expect(res.status).toBe(201);
		const { conversation } = (await res.json()) as { conversation: ConversationDetail };
		expect(conversation.disabledFeatures).toEqual(['web', 'reactions', 'mcp:gone']);
	});
});

describe('PATCH /api/conversations/:id disabledFeatures', () => {
	function seedConversation(): string {
		return createConversation({
			userId,
			endpointId: 'mock',
			modelId: 'mock::chat',
			modelKind: 'chat',
		}).id;
	}

	it('rejects an unknown category and leaves the stored list alone', async () => {
		const id = seedConversation();
		const body = { disabledFeatures: ['made-up-category'] };
		expect(await status(() => PATCH(event(userId, 'PATCH', body, { id })))).toBe(400);
		expect(getConversationMeta(id, userId)?.disabledFeatures).toEqual([]);
	});

	it('accepts built-ins and an unregistered mcp: id', async () => {
		const id = seedConversation();
		const body = { disabledFeatures: ['skills', 'mcp:gone'] };
		expect(await status(() => PATCH(event(userId, 'PATCH', body, { id })))).toBe(204);
		expect(getConversationMeta(id, userId)?.disabledFeatures).toEqual(['skills', 'mcp:gone']);
	});
});
