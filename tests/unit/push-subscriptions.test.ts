import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB }));
vi.mock('$lib/server/db/client', () => ({
	getDb: () => mocks.testDb,
	closeDb: () => {},
}));

import { eq } from 'drizzle-orm';
import {
	upsertPushSubscription,
	listPushSubscriptionsForUser,
	deletePushSubscriptionByEndpoint,
	deletePushSubscriptionsByEndpoints,
} from '$lib/server/db/queries/push-subscriptions';
import { users } from '$lib/server/db/schema';

beforeEach(() => {
	mocks.testDb = createTestDb();
});

afterEach(() => {
	closeTestDb();
});

const SAMPLE = {
	endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
	p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtZ1hcSSnZ2bX5J7ZK_4Q',
	auth: 'tBHItJI5svbpez7KI4CCXg',
	userAgent: 'Mozilla/5.0 Chrome',
};

describe('upsertPushSubscription', () => {
	it('inserts a new row for a fresh endpoint', () => {
		const u = seedUser();
		const row = upsertPushSubscription({ userId: u.id, ...SAMPLE });
		expect(row).toMatchObject({
			userId: u.id,
			endpoint: SAMPLE.endpoint,
			p256dh: SAMPLE.p256dh,
			auth: SAMPLE.auth,
			userAgent: SAMPLE.userAgent,
		});
		expect(row.createdAt).toBe(row.lastSeenAt);
	});

	it('updates last_seen_at + key material but preserves created_at on conflict', async () => {
		const u = seedUser();
		const first = upsertPushSubscription({ userId: u.id, ...SAMPLE });
		// Force a measurable time gap.
		await new Promise((r) => setTimeout(r, 5));
		const second = upsertPushSubscription({
			userId: u.id,
			...SAMPLE,
			p256dh: 'newKey',
			auth: 'newAuth',
		});
		expect(second.createdAt).toBe(first.createdAt);
		expect(second.lastSeenAt).toBeGreaterThan(first.lastSeenAt);
		expect(second.p256dh).toBe('newKey');
		expect(second.auth).toBe('newAuth');
		// One row, not two.
		expect(listPushSubscriptionsForUser(u.id)).toHaveLength(1);
	});

	it('reassigns ownership when a different user resubscribes the same endpoint', () => {
		const a = seedUser();
		const b = seedUser();
		upsertPushSubscription({ userId: a.id, ...SAMPLE });
		upsertPushSubscription({ userId: b.id, ...SAMPLE });
		expect(listPushSubscriptionsForUser(a.id)).toHaveLength(0);
		expect(listPushSubscriptionsForUser(b.id)).toHaveLength(1);
	});
});

describe('listPushSubscriptionsForUser', () => {
	it('returns only the requested user’s subscriptions', () => {
		const a = seedUser();
		const b = seedUser();
		upsertPushSubscription({ userId: a.id, ...SAMPLE, endpoint: 'https://push.example/a1' });
		upsertPushSubscription({ userId: a.id, ...SAMPLE, endpoint: 'https://push.example/a2' });
		upsertPushSubscription({ userId: b.id, ...SAMPLE, endpoint: 'https://push.example/b1' });
		expect(
			listPushSubscriptionsForUser(a.id)
				.map((r) => r.endpoint)
				.sort(),
		).toEqual(['https://push.example/a1', 'https://push.example/a2']);
	});

	it('returns empty array when the user has no subscriptions', () => {
		const u = seedUser();
		expect(listPushSubscriptionsForUser(u.id)).toEqual([]);
	});
});

describe('deletePushSubscriptionByEndpoint', () => {
	it('deletes only when the endpoint is owned by the user', () => {
		const a = seedUser();
		const b = seedUser();
		upsertPushSubscription({ userId: a.id, ...SAMPLE });
		// Wrong owner — must not delete, returns false.
		expect(deletePushSubscriptionByEndpoint(SAMPLE.endpoint, b.id)).toBe(false);
		expect(listPushSubscriptionsForUser(a.id)).toHaveLength(1);
		// Right owner — deletes, returns true.
		expect(deletePushSubscriptionByEndpoint(SAMPLE.endpoint, a.id)).toBe(true);
		expect(listPushSubscriptionsForUser(a.id)).toHaveLength(0);
	});

	it('returns false for an unknown endpoint', () => {
		const u = seedUser();
		expect(deletePushSubscriptionByEndpoint('https://nope', u.id)).toBe(false);
	});
});

describe('deletePushSubscriptionsByEndpoints (stale cleanup)', () => {
	it('removes only the listed endpoints', () => {
		const u = seedUser();
		upsertPushSubscription({ userId: u.id, ...SAMPLE, endpoint: 'a' });
		upsertPushSubscription({ userId: u.id, ...SAMPLE, endpoint: 'b' });
		upsertPushSubscription({ userId: u.id, ...SAMPLE, endpoint: 'c' });
		expect(deletePushSubscriptionsByEndpoints(['a', 'c'])).toBe(2);
		expect(listPushSubscriptionsForUser(u.id).map((r) => r.endpoint)).toEqual(['b']);
	});

	it('is a no-op for an empty list', () => {
		const u = seedUser();
		upsertPushSubscription({ userId: u.id, ...SAMPLE });
		expect(deletePushSubscriptionsByEndpoints([])).toBe(0);
		expect(listPushSubscriptionsForUser(u.id)).toHaveLength(1);
	});
});

describe('FK cascade', () => {
	it('deleting a user cascades to their push_subscriptions rows', () => {
		const u = seedUser();
		upsertPushSubscription({ userId: u.id, ...SAMPLE });
		expect(listPushSubscriptionsForUser(u.id)).toHaveLength(1);
		mocks.testDb.delete(users).where(eq(users.id, u.id)).run();
		expect(listPushSubscriptionsForUser(u.id)).toHaveLength(0);
	});
});
