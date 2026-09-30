/**
 * Persisted endpoint pauses — see `pausedResourceGroups` in the schema, and
 * `endpoints/pause.ts` for the only caller. Operator state, not user-owned, so
 * nothing here is scoped by user id.
 */
import { eq } from 'drizzle-orm';
import { getDb } from '../client';
import { pausedResourceGroups } from '../schema';

export function listPausedResourceGroups(): string[] {
	return getDb()
		.select({ resourceGroup: pausedResourceGroups.resourceGroup })
		.from(pausedResourceGroups)
		.all()
		.map((r) => r.resourceGroup);
}

/** Idempotent in both directions: pausing a paused group keeps its original
 *  `paused_at`, and resuming one that isn't paused deletes nothing. */
export function setResourceGroupPausedRow(resourceGroup: string, paused: boolean): void {
	const db = getDb();
	if (paused) {
		db.insert(pausedResourceGroups)
			.values({ resourceGroup, pausedAt: Date.now() })
			.onConflictDoNothing()
			.run();
	} else {
		db.delete(pausedResourceGroups)
			.where(eq(pausedResourceGroups.resourceGroup, resourceGroup))
			.run();
	}
}
