/**
 * Background worker that fills `media.width` / `media.height` for images stored
 * before those columns existed. Every insert path probes its image now
 * (persister, uploads, code-interpreter outputs), so nothing produces new
 * unprobed rows: a fixed, shrinking queue, and the worker stops itself once
 * it's drained — the topic backfiller's shape.
 *
 * A probe reads the file and decodes only its header, not its pixels, so this
 * runs outside the generation slots, one file at a time. A file that is there
 * and won't decode is recorded as 0 × 0 rather than left NULL, or it would be
 * re-read on every sweep forever (see `media/dimensions.ts`). The marker is
 * permanent, so it is only written for a file that is bad, never one that can't
 * be reached right now. A filesystem error leaves that row NULL and the sweep
 * moves past it — one unreadable file must not hold up the rest of the library —
 * and the next sweep tries it again; a whole batch of them looks like the volume
 * rather than the files, and ends the sweep. A missing file while the media
 * directory is empty ends it too: an unmounted volume at boot, which would
 * otherwise read as every image gone and mark the whole library unreadable.
 *
 * Reads across all users — a background job, not a request path. Disk-store
 * only, like the thumbnail and display variants: it resolves the original's
 * path under `mediaDir()` instead of going through `MediaStore`.
 */
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { listImagesNeedingDimensions, setMediaDimensions } from '../db/queries/media';
import { mediaDir } from '../env';
import { createSweeper } from '../util/sweeper';
import { probeStoredImage, UNKNOWN_DIMENSIONS } from './dimensions';
import { createLogger } from '../log';

const log = createLogger('dimensions-backfill');

const BATCH_SIZE = 50;
const MAX_BATCHES_PER_SWEEP = 20;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
// After the embedding (15s) and topic (20s) backfillers, so a fresh boot
// doesn't start all three at once.
const INITIAL_DELAY_MS = 25_000;

let running = false;

/**
 * Run one pass. Returns how many rows were filled and whether the queue is now
 * empty (`drained`). No-op when a sweep is already running. Safe to call
 * directly (tests).
 */
export async function runDimensionsBackfillSweep(): Promise<{ filled: number; drained: boolean }> {
	if (running) return { filled: 0, drained: false };
	running = true;
	// Rows left NULL this sweep. Not drained while there are any: they are
	// retried next sweep, from the start of the queue.
	let skipped = 0;
	let firstError: unknown;
	try {
		let filled = 0;
		// Asked once, at the first missing file: whether the volume is there.
		let mounted: boolean | undefined;
		let after: { createdAt: number; id: string } | undefined;
		for (let batch = 0; batch < MAX_BATCHES_PER_SWEEP; batch++) {
			const rows = listImagesNeedingDimensions(BATCH_SIZE, after);
			if (rows.length === 0) return { filled, drained: skipped === 0 };
			let unreachable = 0;
			for (const row of rows) {
				after = { createdAt: row.createdAt, id: row.id };
				const probe = await probeStoredImage(resolve(mediaDir(), row.storagePath));
				if ('unavailable' in probe) {
					firstError ??= probe.unavailable;
					unreachable++;
					skipped++;
					continue;
				}
				if ('missing' in probe) {
					mounted ??= await hasEntries(mediaDir());
					if (!mounted) {
						log.warn(`media directory is empty — not mounted? Retrying next sweep.`);
						return { filled, drained: false };
					}
				}
				const dims = 'dims' in probe ? probe.dims : UNKNOWN_DIMENSIONS;
				if (setMediaDimensions(row.id, dims)) filled++;
			}
			// A full batch of them is the volume, not the files: stop reading. (A short batch is the
			// end of the queue: nothing left to stop for.)
			if (unreachable === BATCH_SIZE) {
				return { filled, drained: false };
			}
		}
		return { filled, drained: false };
	} finally {
		running = false;
		if (skipped > 0) {
			log.warn(`could not read ${skipped} image(s), retrying next sweep:`, firstError);
		}
	}
}

async function hasEntries(dir: string): Promise<boolean> {
	try {
		return (await readdir(dir)).length > 0;
	} catch {
		return false;
	}
}

const sweeper = createSweeper({
	name: 'dimensions-backfill',
	intervalMs: SWEEP_INTERVAL_MS,
	initialDelayMs: INITIAL_DELAY_MS,
	sweep: runDimensionsBackfillSweep,
	isDrained: (r) => r.drained,
});

/** Mount the backfiller. Idempotent; stops for good once the queue drains. */
export function startDimensionsBackfiller(): void {
	sweeper.start();
}

/** Tear down — for tests / clean shutdown. Safe during an in-flight sweep. */
export function stopDimensionsBackfiller(): void {
	sweeper.stop();
}
