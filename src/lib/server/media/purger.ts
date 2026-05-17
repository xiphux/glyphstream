/**
 * Background sweeper that hard-deletes abandoned uploads.
 *
 * Scope under the library model:
 *   - Generated media (origin='generated') is never auto-purged. It
 *     persists indefinitely once produced and is deleted only by
 *     explicit user action (gallery delete, conversation-delete
 *     "also delete media" checkbox, branch-delete).
 *   - Uploaded media (origin='uploaded') is transient. A user picks a
 *     file, the row is inserted with `unreferenced_since = now`, and
 *     if `linkMessageMedia` doesn't clear that flag before the grace
 *     period elapses we assume the upload was abandoned and reap it.
 *
 * Cadence is hardcoded rather than env-configurable: with generated
 * media no longer touched, the meaningful tradeoff lives in a narrow
 * band. Too tight and a user's half-composed message loses its upload
 * to a phone call. Too loose and orphaned bytes linger pointlessly.
 * 15-minute sweep / 30-minute grace is conservative inside that band —
 * no real disk-space savings from going lower, and the failure mode
 * of going lower is "user has to re-pick a file from their device"
 * (an inconvenience, not data loss).
 *
 * Lifecycle:
 *   - At startup we mount a setInterval; one tick = one sweep.
 *   - Each sweep does two things, in order:
 *       1. Stamp any zero-ref-count uploaded rows that lack
 *          `unreferenced_since` (e.g. orphans from a crash between
 *          insertMedia and linkMessageMedia). They re-enter the
 *          grace-period clock.
 *       2. Find uploaded rows where `unreferenced_since < now - graceMs`
 *          AND `hard_deleted_at IS NULL`, unlink the file from disk
 *          via MediaStore, and stamp `hard_deleted_at`.
 *   - We bound batch size per sweep (500) so a backlog after a long
 *     downtime can't lock up the DB or blow the event loop with a single
 *     huge transaction. The next tick picks up where this one left off.
 *
 * Why setInterval and not a cron / job library: we're a single-Node
 * deploy with no other workers; a long-lived interval inside the
 * SvelteKit process is the smallest viable footprint. If we ever go
 * multi-node we'll move this to its own process.
 */

import {
	findPurgeCandidates,
	markHardDeleted,
	stampOrphanedZeroRefRows
} from '../db/queries/media';
import { getMediaStore } from './disk-store';

const BATCH_SIZE = 500;
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;
const GRACE_PERIOD_MS = 30 * 60 * 1000;

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

		const cutoff = Date.now() - GRACE_PERIOD_MS;
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
	// Run a sweep shortly after boot so a process restart doesn't have to
	// wait the full interval to clean up anything that fell due during the
	// downtime. 10s is enough for the DB connection to be warm.
	const initialDelayMs = 10_000;
	timer = setTimeout(function tick() {
		runPurgeSweep()
			.catch((e) => console.error('[purger] sweep failed:', e))
			.finally(() => {
				timer = setTimeout(tick, SWEEP_INTERVAL_MS);
			});
	}, initialDelayMs);
	console.log(
		`[purger] started; sweep every ${SWEEP_INTERVAL_MS / 60000}min, grace ${
			GRACE_PERIOD_MS / 60000
		}min (uploads only)`
	);
}

/** Tear down the timer — useful for tests / clean shutdown. */
export function stopMediaPurger(): void {
	if (timer) {
		clearTimeout(timer);
		timer = null;
	}
}
