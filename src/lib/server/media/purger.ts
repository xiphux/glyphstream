/**
 * Background sweeper: reaps abandoned uploads and expires the trash.
 *
 * Scope under the library model:
 *   - Generated media (origin='generated') is never auto-purged for being
 *     unreferenced. It persists indefinitely once produced and leaves the
 *     library only by explicit user action (gallery delete, conversation-
 *     delete "also delete media" checkbox, branch-delete) — and those move
 *     it to the trash ("Recently deleted") rather than unlinking it. This
 *     sweeper unlinks trashed bytes once TRASH_RETENTION_MS has passed.
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
 * (an inconvenience, not data loss). The trash retention rides the same
 * tick; at 30 days, a 15-minute granularity is noise.
 *
 * Lifecycle:
 *   - At startup we mount a setInterval; one tick = one sweep.
 *   - Each sweep does three things, in order:
 *       1. Stamp any zero-ref-count uploaded rows that lack
 *          `unreferenced_since` (e.g. orphans from a crash between
 *          insertMedia and linkMessageMedia). They re-enter the
 *          grace-period clock.
 *       2. Find uploaded rows where `unreferenced_since < now - graceMs`
 *          AND `deleted_at IS NULL`, unlink the file from disk
 *          via MediaStore, and stamp `deleted_at` + `purged_at`.
 *       3. Claim trashed rows where `deleted_at < now - retention`
 *          AND `purged_at IS NULL` (stamp `purged_at`), then unlink.
 *   - We bound batch size per phase (500) so a backlog after a long
 *     downtime can't lock up the DB or blow the event loop with a single
 *     huge transaction. The next tick picks up where this one left off.
 *
 * Why setInterval and not a cron / job library: we're a single-Node
 * deploy with no other workers; a long-lived interval inside the
 * SvelteKit process is the smallest viable footprint. If we ever go
 * multi-node we'll move this to its own process.
 */

import {
	claimExpiredTrash,
	claimAbandonedUploads,
	stampOrphanedZeroRefRows,
	type PurgeCandidate,
} from '../db/queries/media';
import { getMediaStore } from './disk-store';
import { TRASH_RETENTION_MS } from './trash';
import { createSweeper } from '../util/sweeper';

const BATCH_SIZE = 500;
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;
const GRACE_PERIOD_MS = 30 * 60 * 1000;
// Run a sweep shortly after boot so a process restart doesn't have to wait the
// full interval to clean up anything that fell due during the downtime. 10s is
// enough for the DB connection to be warm.
const INITIAL_DELAY_MS = 10_000;
const PURGE_CONCURRENCY = 8;

let running = false;

/**
 * Unlink each claimed candidate's bytes. The rows were already stamped by the
 * claim, so nothing is written here; a failed unlink is logged and leaks the
 * file.
 *
 * Concurrent rather than one candidate at a time. Each delete is three unlinks
 * (original + .thumb.jpg + .vision.jpg), so a full 500-row batch was up to 1500
 * serialized filesystem round trips. Nothing here blocks the event loop (it's
 * all async I/O) — it just made the sweep take far longer than it needed to.
 * Bounded so a large batch can't saturate the filesystem queue against
 * foreground media reads.
 */
async function unlinkAll(candidates: PurgeCandidate[]): Promise<void> {
	const store = getMediaStore();
	for (let i = 0; i < candidates.length; i += PURGE_CONCURRENCY) {
		const slice = candidates.slice(i, i + PURGE_CONCURRENCY);
		await Promise.all(
			slice.map(async (c) => {
				try {
					await store.delete(c.storagePath);
				} catch (e) {
					// Log and continue — one bad row shouldn't block the batch.
					console.warn(`[purger] failed to delete bytes of ${c.id}:`, e);
				}
			}),
		);
	}
}

/**
 * Run one sweep. Returns counts so callers / tests can verify behaviour.
 * Safe to call directly even with the periodic timer running — the `running`
 * guard prevents two sweeps from overlapping.
 */
export async function runPurgeSweep(): Promise<{
	stamped: number;
	hardDeleted: number;
	trashExpired: number;
}> {
	if (running) return { stamped: 0, hardDeleted: 0, trashExpired: 0 };
	running = true;
	try {
		const stamped = stampOrphanedZeroRefRows();
		const now = Date.now();
		// Both phases claim (stamp) their rows synchronously and only then
		// unlink — see `claimAbandonedUploads` / `claimExpiredTrash` for why a
		// mark after the awaited unlink was a race.
		const uploads = claimAbandonedUploads(now - GRACE_PERIOD_MS, BATCH_SIZE);
		await unlinkAll(uploads);
		const hardDeleted = uploads.length;
		const claimed = claimExpiredTrash(now - TRASH_RETENTION_MS, BATCH_SIZE);
		await unlinkAll(claimed);
		const trashExpired = claimed.length;

		if (stamped > 0 || hardDeleted > 0 || trashExpired > 0) {
			console.log(
				`[purger] sweep done: stamped=${stamped}, hardDeleted=${hardDeleted}, trashExpired=${trashExpired}`,
			);
		}
		return { stamped, hardDeleted, trashExpired };
	} finally {
		running = false;
	}
}

const sweeper = createSweeper({
	name: 'purger',
	intervalMs: SWEEP_INTERVAL_MS,
	initialDelayMs: INITIAL_DELAY_MS,
	sweep: runPurgeSweep,
	startedDetail: `upload grace ${GRACE_PERIOD_MS / 60000}min, trash ${TRASH_RETENTION_MS / 86_400_000}d`,
});

/**
 * Mount the periodic sweeper. Idempotent — calling twice is a no-op so
 * SvelteKit's hooks.server.ts can call it freely.
 */
export function startMediaPurger(): void {
	sweeper.start();
}

/** Tear down the timer — useful for tests / clean shutdown. */
export function stopMediaPurger(): void {
	sweeper.stop();
}
