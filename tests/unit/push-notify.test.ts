import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({
	testDb: null as unknown as TestDB,
	sendCalls: [] as Array<{ subscription: unknown; payload: string }>,
	sendResult: { ok: true } as { ok: boolean; statusCode?: number },
	sendResultsByEndpoint: new Map<string, { ok: boolean; statusCode?: number }>(),
}));

vi.mock('$lib/server/db/client', () => ({
	getDb: () => mocks.testDb,
	closeDb: () => {},
}));

vi.mock('$lib/server/push/web-push', () => ({
	sendPushNotification: vi.fn(async (subscription: { endpoint: string }, payload: string) => {
		mocks.sendCalls.push({ subscription, payload });
		return mocks.sendResultsByEndpoint.get(subscription.endpoint) ?? mocks.sendResult;
	}),
}));

import { buildPreview, notifyConversationComplete } from '$lib/server/push/notify';
import {
	listPushSubscriptionsForUser,
	upsertPushSubscription,
} from '$lib/server/db/queries/push-subscriptions';
import { setUserPreferences } from '$lib/server/db/queries/user-preferences';
import { recordPresence, resetPresence } from '$lib/server/push/presence';

beforeEach(() => {
	mocks.testDb = createTestDb();
	mocks.sendCalls = [];
	mocks.sendResult = { ok: true };
	mocks.sendResultsByEndpoint = new Map();
	resetPresence();
});

afterEach(() => {
	closeTestDb();
	resetPresence();
});

const SAMPLE_KEYS = {
	p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtZ1hcSSnZ2bX5J7ZK_4Q',
	auth: 'tBHItJI5svbpez7KI4CCXg',
};

describe('buildPreview', () => {
	it('returns empty string for empty input', () => {
		expect(buildPreview('')).toBe('');
	});

	it('strips code fences, inline code, headers, bold/italic, links', () => {
		const md =
			'# Title\n\n**Bold** and *italic* and `code`. See [link](https://x).\n\n```js\nconst x = 1;\n```\nDone.';
		const out = buildPreview(md);
		expect(out).not.toMatch(/[*#`]/);
		expect(out).not.toContain('https://x');
		expect(out).toContain('Title');
		expect(out).toContain('Bold');
		expect(out).toContain('link');
		expect(out).not.toContain('const x');
	});

	it('strips list markers and blockquotes', () => {
		const md = '- one\n- two\n\n> a quote\n\n1. first\n2. second';
		const out = buildPreview(md);
		expect(out).toBe('one two a quote first second');
	});

	it('collapses whitespace to single spaces', () => {
		expect(buildPreview('a\n\n\nb\t\tc')).toBe('a b c');
	});

	it('truncates to maxChars with ellipsis', () => {
		const long = 'a'.repeat(200);
		const out = buildPreview(long, 50);
		expect(out.length).toBe(50);
		expect(out.endsWith('…')).toBe(true);
	});

	it('does not truncate strings already shorter than maxChars', () => {
		expect(buildPreview('short', 50)).toBe('short');
	});
});

describe('notifyConversationComplete', () => {
	function baseInput(userId: string) {
		return {
			userId,
			conversationId: 'conv1',
			assistantMessageId: 'msg1',
			conversationTitle: 'About cats',
			previewText: 'Cats are mysterious **creatures**.',
			modality: 'chat' as const,
		};
	}

	it('bails when notificationsEnabled is false', async () => {
		const u = seedUser();
		upsertPushSubscription({ userId: u.id, endpoint: 'a', ...SAMPLE_KEYS });
		// Pref defaults notificationsEnabled = false.
		await notifyConversationComplete(baseInput(u.id));
		expect(mocks.sendCalls).toHaveLength(0);
	});

	it('bails when the user has no subscriptions', async () => {
		const u = seedUser();
		setUserPreferences(u.id, { notificationsEnabled: true });
		await notifyConversationComplete(baseInput(u.id));
		expect(mocks.sendCalls).toHaveLength(0);
	});

	it('omits the preview field when notificationsShowContent is false', async () => {
		const u = seedUser();
		setUserPreferences(u.id, { notificationsEnabled: true });
		upsertPushSubscription({ userId: u.id, endpoint: 'a', ...SAMPLE_KEYS });
		await notifyConversationComplete(baseInput(u.id));
		expect(mocks.sendCalls).toHaveLength(1);
		const payload = JSON.parse(mocks.sendCalls[0].payload);
		expect(payload).not.toHaveProperty('preview');
		expect(payload).toMatchObject({
			type: 'message_complete',
			conversationId: 'conv1',
			conversationTitle: 'About cats',
			foregroundToast: true,
			modality: 'chat',
		});
	});

	it('includes a stripped preview when notificationsShowContent is true', async () => {
		const u = seedUser();
		setUserPreferences(u.id, {
			notificationsEnabled: true,
			notificationsShowContent: true,
		});
		upsertPushSubscription({ userId: u.id, endpoint: 'a', ...SAMPLE_KEYS });
		await notifyConversationComplete(baseInput(u.id));
		const payload = JSON.parse(mocks.sendCalls[0].payload);
		expect(payload.preview).toBe('Cats are mysterious creatures.');
	});

	it('truncates a long conversation title', async () => {
		const u = seedUser();
		setUserPreferences(u.id, { notificationsEnabled: true });
		upsertPushSubscription({ userId: u.id, endpoint: 'a', ...SAMPLE_KEYS });
		const longTitle = 'x'.repeat(100);
		await notifyConversationComplete({ ...baseInput(u.id), conversationTitle: longTitle });
		const payload = JSON.parse(mocks.sendCalls[0].payload);
		expect(payload.conversationTitle.length).toBe(60);
		expect(payload.conversationTitle.endsWith('…')).toBe(true);
	});

	it('fans out to every subscription in parallel', async () => {
		const u = seedUser();
		setUserPreferences(u.id, { notificationsEnabled: true });
		upsertPushSubscription({ userId: u.id, endpoint: 'a', ...SAMPLE_KEYS });
		upsertPushSubscription({ userId: u.id, endpoint: 'b', ...SAMPLE_KEYS });
		upsertPushSubscription({ userId: u.id, endpoint: 'c', ...SAMPLE_KEYS });
		await notifyConversationComplete(baseInput(u.id));
		expect(
			new Set(mocks.sendCalls.map((c) => (c.subscription as { endpoint: string }).endpoint)),
		).toEqual(new Set(['a', 'b', 'c']));
	});

	it('deletes subscriptions that return 410 Gone but keeps healthy ones', async () => {
		const u = seedUser();
		setUserPreferences(u.id, { notificationsEnabled: true });
		upsertPushSubscription({ userId: u.id, endpoint: 'good', ...SAMPLE_KEYS });
		upsertPushSubscription({ userId: u.id, endpoint: 'gone', ...SAMPLE_KEYS });
		mocks.sendResultsByEndpoint.set('gone', { ok: false, statusCode: 410 });
		await notifyConversationComplete(baseInput(u.id));
		const remaining = listPushSubscriptionsForUser(u.id).map((r) => r.endpoint);
		expect(remaining).toEqual(['good']);
	});

	it('deletes on 404 (some push services use it instead of 410)', async () => {
		const u = seedUser();
		setUserPreferences(u.id, { notificationsEnabled: true });
		upsertPushSubscription({ userId: u.id, endpoint: 'a', ...SAMPLE_KEYS });
		mocks.sendResultsByEndpoint.set('a', { ok: false, statusCode: 404 });
		await notifyConversationComplete(baseInput(u.id));
		expect(listPushSubscriptionsForUser(u.id)).toHaveLength(0);
	});

	it('does NOT delete on transient failures (5xx, network)', async () => {
		const u = seedUser();
		setUserPreferences(u.id, { notificationsEnabled: true });
		upsertPushSubscription({ userId: u.id, endpoint: 'a', ...SAMPLE_KEYS });
		mocks.sendResultsByEndpoint.set('a', { ok: false, statusCode: 503 });
		await notifyConversationComplete(baseInput(u.id));
		expect(listPushSubscriptionsForUser(u.id)).toHaveLength(1);
	});

	it('suppresses all pushes when a device is actively viewing the conversation', async () => {
		const u = seedUser();
		setUserPreferences(u.id, { notificationsEnabled: true });
		upsertPushSubscription({ userId: u.id, endpoint: 'a', ...SAMPLE_KEYS });
		// A window on another device is watching this thread (its live SSE
		// stream already delivers the message) — no device should be pushed.
		recordPresence(u.id, 'conv1', 'viewer-1', true);
		await notifyConversationComplete(baseInput(u.id));
		expect(mocks.sendCalls).toHaveLength(0);
	});

	it('still pushes when the viewed conversation is a DIFFERENT one', async () => {
		const u = seedUser();
		setUserPreferences(u.id, { notificationsEnabled: true });
		upsertPushSubscription({ userId: u.id, endpoint: 'a', ...SAMPLE_KEYS });
		// Watching some other thread must not suppress this conversation's push.
		recordPresence(u.id, 'other-conv', 'viewer-1', true);
		await notifyConversationComplete(baseInput(u.id));
		expect(mocks.sendCalls).toHaveLength(1);
	});

	it('respects notificationsForegroundToast in the payload', async () => {
		const u = seedUser();
		setUserPreferences(u.id, {
			notificationsEnabled: true,
			notificationsForegroundToast: false,
		});
		upsertPushSubscription({ userId: u.id, endpoint: 'a', ...SAMPLE_KEYS });
		await notifyConversationComplete(baseInput(u.id));
		const payload = JSON.parse(mocks.sendCalls[0].payload);
		expect(payload.foregroundToast).toBe(false);
	});
});
