/**
 * Disabling an account stops what it already started, as deleting it does:
 * nobody can sign in to read the result, and the endpoint time is someone
 * else's.
 */
import type { RequestEvent } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB }));

import { PATCH, DELETE } from '../../src/routes/api/admin/users/[id]/+server';
import { users } from '#lib/server/db/schema.js';
import { createSession, validateSessionToken } from '#lib/server/auth/session.js';
import { createConversation } from '#lib/server/db/queries/conversations.js';
import { registerInFlight } from '#lib/server/streaming/in-flight.js';
import type { LoadedEndpoint } from '#lib/server/endpoints/config.js';

type Handler = (e: RequestEvent) => unknown;
const endpoint = { id: 'e', baseUrl: 'http://127.0.0.1:9/v1' } as unknown as LoadedEndpoint;

let admin: NonNullable<App.Locals['user']>;
let targetId: string;
let conversationId: string;

async function asAdmin(fn: Handler, method: string, body?: unknown): Promise<number> {
	const url = new URL(`/api/admin/users/${targetId}`, 'https://chat.example.test');
	const event = {
		url,
		params: { id: targetId },
		locals: { user: admin, sessionId: null },
		request: new Request(url, {
			method,
			headers: { 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
	} as unknown as RequestEvent;
	try {
		return ((await fn(event)) as Response).status;
	} catch (e) {
		if (e && typeof e === 'object' && 'status' in e) return Number(e.status);
		throw e;
	}
}

beforeEach(() => {
	mocks.testDb = createTestDb();
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	const a = seedUser();
	mocks.testDb.update(users).set({ role: 'admin' }).where(eq(users.id, a.id)).run();
	admin = validateSessionToken(createSession(a.id).token)!.user;
	expect(admin.role).toBe('admin');
	targetId = seedUser().id;
	conversationId = createConversation({
		userId: targetId,
		endpointId: 'e',
		modelId: 'e::m',
		modelKind: 'image',
	}).id;
});

afterEach(() => {
	closeTestDb();
	vi.restoreAllMocks();
});

describe('disabling an account stops the generations it has in flight', () => {
	it('baseline: deleting the account aborts them', async () => {
		const entry = registerInFlight(conversationId, endpoint, 'b1', 'image', 'e::m');
		expect(await asAdmin(DELETE as Handler, 'DELETE')).toBe(200);
		await Promise.resolve();
		expect(entry.controller.signal.aborted).toBe(true);
	});

	it('disabling the account aborts them too', async () => {
		const entry = registerInFlight(conversationId, endpoint, 'b1', 'image', 'e::m');
		expect(await asAdmin(PATCH as Handler, 'PATCH', { disabled: true })).toBe(200);
		await Promise.resolve();
		expect(entry.controller.signal.aborted).toBe(true);
	});

	it("leaves other accounts' generations running", async () => {
		const other = createConversation({
			userId: seedUser().id,
			endpointId: 'e',
			modelId: 'e::m',
			modelKind: 'image',
		}).id;
		const entry = registerInFlight(other, endpoint, 'b1', 'image', 'e::m');
		expect(await asAdmin(PATCH as Handler, 'PATCH', { disabled: true })).toBe(200);
		await Promise.resolve();
		expect(entry.controller.signal.aborted).toBe(false);
	});

	it('re-enabling the account stops nothing', async () => {
		const entry = registerInFlight(conversationId, endpoint, 'b1', 'image', 'e::m');
		expect(await asAdmin(PATCH as Handler, 'PATCH', { disabled: false })).toBe(200);
		await Promise.resolve();
		expect(entry.controller.signal.aborted).toBe(false);
	});
});
