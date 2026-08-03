/**
 * Push subscription queries. One row per (user, browser-endpoint). The
 * endpoint URL is the identity — resubscribing from the same device
 * produces the same endpoint, and we upsert on it so a stale row never
 * lingers when the user re-enables notifications. If the same device
 * had previously been subscribed under a different user (account
 * switch on a shared browser), the prior row is dropped and replaced
 * rather than adopted — one endpoint can only hold one row, which the
 * UNIQUE constraint enforces anyway.
 */

import { and, eq, inArray, ne } from 'drizzle-orm';
import { generateId } from '../../util/id';
import { getDb, type Tx } from '../client';
import { pushSubscriptions } from '../schema';

export interface PushSubscriptionRow {
	id: string;
	userId: string;
	endpoint: string;
	p256dh: string;
	auth: string;
	userAgent: string | null;
	createdAt: number;
	lastSeenAt: number;
}

interface UpsertInput {
	userId: string;
	endpoint: string;
	p256dh: string;
	auth: string;
	userAgent?: string | null;
}

/**
 * Insert-or-update a push subscription keyed by its endpoint URL.
 * On conflict we refresh the key material (in case it rotated
 * client-side), the user-agent string, and last_seen_at — but never
 * created_at, which keeps "first subscribed" stable for the future
 * "your devices" UI.
 *
 * The upsert used to also SET user_id to the caller, which made it the one
 * write in the codebase that mutated a row without first proving the caller
 * owned it: anyone who knew another user's endpoint URL could re-point that
 * device at their own notifications, which carry conversation titles and
 * message previews. The endpoint is high-entropy and no route discloses it,
 * so this was hard to reach — but "hard to guess" isn't the ownership
 * invariant the rest of the schema holds to.
 *
 * A foreign row is now deleted and replaced rather than adopted. That keeps
 * the shared-browser case working (the same physical device re-subscribing
 * under a second account gets a clean row) while making the ownership
 * transfer explicit rather than a silent side effect of an UPDATE.
 */
export function upsertPushSubscription(input: UpsertInput): PushSubscriptionRow {
	const db = getDb();
	const now = Date.now();
	const newId = generateId();
	return db.transaction((tx) => {
		tx.delete(pushSubscriptions)
			.where(
				and(
					eq(pushSubscriptions.endpoint, input.endpoint),
					ne(pushSubscriptions.userId, input.userId),
				),
			)
			.run();
		return upsertOwnRow(tx, input, newId, now);
	});
}

function upsertOwnRow(tx: Tx, input: UpsertInput, newId: string, now: number): PushSubscriptionRow {
	const db = tx;
	db.insert(pushSubscriptions)
		.values({
			id: newId,
			userId: input.userId,
			endpoint: input.endpoint,
			p256dh: input.p256dh,
			auth: input.auth,
			userAgent: input.userAgent ?? null,
			createdAt: now,
			lastSeenAt: now,
		})
		.onConflictDoUpdate({
			target: pushSubscriptions.endpoint,
			set: {
				p256dh: input.p256dh,
				auth: input.auth,
				userAgent: input.userAgent ?? null,
				lastSeenAt: now,
			},
		})
		.run();
	const row = db
		.select()
		.from(pushSubscriptions)
		.where(eq(pushSubscriptions.endpoint, input.endpoint))
		.get();
	if (!row) throw new Error('upsertPushSubscription: row vanished after upsert');
	return row;
}

/**
 * List a user's subscriptions for fan-out at notify time. Returned in
 * insertion order; we never sort because the order doesn't drive any
 * UX (the "devices" UI will sort by lastSeenAt when it ships).
 */
export function listPushSubscriptionsForUser(userId: string): PushSubscriptionRow[] {
	const db = getDb();
	return db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId)).all();
}

/**
 * Delete one subscription scoped to a user, used by the unsubscribe
 * endpoint. Returns true iff a row was deleted — lets the API surface
 * a 404 for "tried to unsubscribe an endpoint you don't own."
 */
export function deletePushSubscriptionByEndpoint(endpoint: string, userId: string): boolean {
	const db = getDb();
	const result = db
		.delete(pushSubscriptions)
		.where(and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.userId, userId)))
		.run();
	return result.changes > 0;
}

/**
 * Bulk delete by endpoint, used by the notify pipeline when the push
 * service returns 404/410 ("subscription is gone"). Unscoped because
 * the caller has already established these endpoints belong to a known
 * user (it's iterating that user's own subscription list).
 */
export function deletePushSubscriptionsByEndpoints(endpoints: string[]): number {
	if (endpoints.length === 0) return 0;
	const db = getDb();
	const result = db
		.delete(pushSubscriptions)
		.where(inArray(pushSubscriptions.endpoint, endpoints))
		.run();
	// node:sqlite types `changes` as `number | bigint`; affected-row counts
	// are always within safe-integer range, so narrowing to number is safe.
	return Number(result.changes);
}
