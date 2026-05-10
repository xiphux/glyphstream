/**
 * Background sweeper that hard-deletes media whose grace period has elapsed.
 *
 * Lifecycle:
 *   - At startup we mount a setInterval; one tick = one sweep.
 *   - Each sweep does two things, in order:
 *       1. Stamp any zero-ref-count rows that lack `unreferenced_since`
 *          (e.g. orphans from a crash between insertMedia and
 *          linkMessageMedia). They re-enter the grace-period clock.
 *       2. Find rows where `unreferenced_since < now - graceMs` AND
 *          `hard_deleted_at IS NULL`, unlink the file from disk via
 *          MediaStore, and stamp `hard_deleted_at`.
 *
 *   - We bound batch size per sweep (default 500) so a backlog after a long
 *     downtime can't lock up the DB or blow the event loop with a single
 *     huge transaction. The next tick picks up where this one left off.
 *
 * Why setInterval and not a cron / job library: we're a single-Node deploy
 * with no other workers; a long-lived interval inside the SvelteKit process
 * is the smallest viable footprint. If we ever go multi-node we'll move
 * this to its own process.
 */

import { mediaGracePeriodDays, mediaPurgeIntervalSeconds } from '../env';
import {
	findPurgeCandidates,
	markHardDeleted,
	stampOrphanedZeroRefRows
} from '../db/queries/media';
import { getMediaStore } from './disk-store';

const BATCH_SIZE = 500;

let timer: NodeJS.Timeout | null = null;
let running = false;

/**
 * Run one sweep. Returns counts so callers / tests can verify behaviour.
 * Safe to call directly even with the periodic timer running — the `running`
 * guard prevents two sweeps from overlapping.
 */
export async function runPurgeSweep(): Promise<{
	stamped: number;
	hardDeleted: number;
}> {
	if (running) return { stamped: 0, hardDeleted: 0 };
	running = true;
	try {
		const stamped = stampOrphanedZeroRefRows();

		const graceMs = mediaGracePeriodDays() * 86_400_000;
		const cutoff = Date.now() - graceMs;
		const candidates = findPurgeCandidates(cutoff, BATCH_SIZE);

		const store = getMediaStore();
		let hardDeleted = 0;
		for (const c of candidates) {
			try {
				await store.delete(c.storagePath);
				markHardDeleted(c.id);
				hardDeleted++;
			} catch (e) {
				// Log and continue — one bad row shouldn't block the batch.
				console.warn(`[purger] failed to hard-delete ${c.id}:`, e);
			}
		}

		if (stamped > 0 || hardDeleted > 0) {
			console.log(
				`[purger] sweep done: stamped=${stamped}, hardDeleted=${hardDeleted}`
			);
		}
		return { stamped, hardDeleted };
	} finally {
		running = false;
	}
}

/**
 * Mount the periodic sweeper. Idempotent — calling twice is a no-op so
 * SvelteKit's hooks.server.ts can call it freely.
 */
export function startMediaPurger(): void {
	if (timer) return;
	const intervalMs = Math.max(60, mediaPurgeIntervalSeconds()) * 1000;
	// Run a sweep shortly after boot so a process restart doesn't have to
	// wait the full interval to clean up anything that fell due during the
	// downtime. 10s is enough for the DB connection to be warm.
	const initialDelayMs = 10_000;
	timer = setTimeout(function tick() {
		runPurgeSweep()
			.catch((e) => console.error('[purger] sweep failed:', e))
			.finally(() => {
				timer = setTimeout(tick, intervalMs);
			});
	}, initialDelayMs);
	console.log(
		`[purger] started; sweep every ${intervalMs / 1000}s, grace ${mediaGracePeriodDays()}d`
	);
}

/** Tear down the timer — useful for tests / clean shutdown. */
export function stopMediaPurger(): void {
	if (timer) {
		clearTimeout(timer);
		timer = null;
	}
}
