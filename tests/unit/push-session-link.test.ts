/**
 * A device's push subscription belongs to the session that registered it:
 * signing out, revoking the session or its expiry stops pushes to that
 * device, and the next session to register the same endpoint takes it over.
 */
import type { Cookies, RequestEvent } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({
	testDb: null as unknown as TestDB,
	sent: [] as Array<{ endpoint: string; payload: string }>,
}));
vi.mock('#lib/server/push/web-push.js', () => ({
	getVapidPublicKey: () => 'test-vapid-public-key',
	sendPushNotification: (sub: { endpoint: string }, payload: string) => {
		mocks.sent.push({ endpoint: sub.endpoint, payload });
		return Promise.resolve({ ok: true });
	},
}));

import { POST as subscribe } from '../../src/routes/api/push/subscribe/+server';
import { POST as logout } from '../../src/routes/api/auth/logout/+server';
import { DELETE as revokeSession } from '../../src/routes/api/auth/sessions/[id]/+server';
import { DELETE as revokeOthers } from '../../src/routes/api/auth/sessions/+server';
import {
	createSession,
	deleteExpiredSessions,
	validateSessionToken,
} from '#lib/server/auth/session.js';
import { setUserPreferences } from '#lib/server/db/queries/user-preferences.js';
import { notifyConversationComplete } from '#lib/server/push/notify.js';
import { resetPresence } from '#lib/server/push/presence.js';

const ORIGIN = 'https://chat.example.test';
const SESSION_COOKIE = 'glyphstream_session';
// A public IP literal: passes the endpoint's routability check without DNS.
const LOST_PHONE = 'https://8.8.8.8/push/lost-phone';

function jarWith(token: string) {
	const jar = new Map<string, string>([[SESSION_COOKIE, token]]);
	return {
		get: (n: string) => jar.get(n),
		getAll: () => [...jar].map(([name, value]) => ({ name, value })),
		set: (n: string, v: string) => void jar.set(n, v),
		delete: (n: string) => void jar.delete(n),
		serialize: () => '',
	} as unknown as Cookies;
}

type Handler = (event: RequestEvent) => Promise<Response> | Response;

/** Call `handler` as the session behind `token`, the way the session hook would. */
async function call(
	handler: Handler,
	token: string,
	opts: { method: string; body?: unknown; params?: Record<string, string> },
): Promise<number> {
	const ctx = validateSessionToken(token);
	const url = new URL('/api/x', ORIGIN);
	const event = {
		url,
		params: opts.params ?? {},
		cookies: jarWith(token),
		locals: { user: ctx?.user ?? null, sessionId: ctx?.sessionId ?? null, appLock: null },
		request: new Request(url, {
			method: opts.method,
			headers: { 'content-type': 'application/json' },
			body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
		}),
	} as unknown as RequestEvent;
	try {
		return (await handler(event)).status;
	} catch (e) {
		if (e && typeof e === 'object' && 'status' in e) return Number(e.status);
		throw e;
	}
}

async function completeATurn(userId: string): Promise<void> {
	await notifyConversationComplete({
		userId,
		conversationId: 'conv-1',
		assistantMessageId: 'msg-1',
		conversationTitle: 'Medical results',
		previewText: 'Your biopsy came back and…',
		modality: 'chat',
	});
}

let userId: string;
let phone: string;
let laptop: string;

beforeEach(async () => {
	mocks.testDb = createTestDb();
	mocks.sent.length = 0;
	resetPresence();
	userId = seedUser().id;
	setUserPreferences(userId, { notificationsEnabled: true, notificationsShowContent: true });
	phone = createSession(userId, 'phone').token;
	laptop = createSession(userId, 'laptop').token;
	const status = await call(subscribe as Handler, phone, {
		method: 'POST',
		body: { endpoint: LOST_PHONE, keys: { p256dh: 'p', auth: 'a' } },
	});
	expect(status).toBe(201);
});

afterEach(() => closeTestDb());

describe('ending a session ends its push subscription', () => {
	it('baseline: the signed-in phone is pushed the title and preview', async () => {
		await completeATurn(userId);
		expect(mocks.sent).toHaveLength(1);
		expect(mocks.sent[0].payload).toContain('Medical results');
		expect(mocks.sent[0].payload).toContain('biopsy');
	});

	it('after Sign out on the phone', async () => {
		expect(await call(logout as Handler, phone, { method: 'POST' })).toBe(302);
		expect(validateSessionToken(phone)).toBeNull();
		await completeATurn(userId);
		expect(mocks.sent).toEqual([]);
	});

	it("after the laptop revokes the phone's session", async () => {
		const phoneSessionId = validateSessionToken(phone)!.sessionId;
		const status = await call(revokeSession as Handler, laptop, {
			method: 'DELETE',
			params: { id: phoneSessionId },
		});
		expect(status).toBe(200);
		await completeATurn(userId);
		expect(mocks.sent).toEqual([]);
	});

	it('after "Sign out everywhere else" from the laptop', async () => {
		expect(await call(revokeOthers as Handler, laptop, { method: 'DELETE' })).toBe(200);
		expect(validateSessionToken(phone)).toBeNull();
		await completeATurn(userId);
		expect(mocks.sent).toEqual([]);
	});

	it('when the session expires and the sweep removes it', async () => {
		expect(deleteExpiredSessions(Date.now() + 365 * 24 * 3_600_000)).toBeGreaterThan(0);
		await completeATurn(userId);
		expect(mocks.sent).toEqual([]);
	});

	it('moves to a new session that registers the same device', async () => {
		const again = createSession(userId, 'phone').token;
		expect(
			await call(subscribe as Handler, again, {
				method: 'POST',
				body: { endpoint: LOST_PHONE, keys: { p256dh: 'p', auth: 'a' } },
			}),
		).toBe(201);
		expect(await call(logout as Handler, phone, { method: 'POST' })).toBe(302);
		await completeATurn(userId);
		expect(mocks.sent.map((s) => s.endpoint)).toEqual([LOST_PHONE]);
	});
});
