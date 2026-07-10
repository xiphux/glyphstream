/**
 * Background worker that fills `memories.topic` for rows that lack one — the
 * historical backlog of memories created before the `topic` field existed. New
 * memories get a model-authored topic from the save_memory/update_memory tools,
 * so nothing produces new null-topic rows: this is a fixed, shrinking queue, and
 * the worker stops itself once it's drained.
 *
 * Mirrors the embedding backfiller's shape — recursive setTimeout tick with a
 * `running` re-entrancy guard, an idempotent start, a directly-callable sweep
 * for tests, and a no-op mount when unconfigured — but uses the task model
 * (title-generation tier) for one short completion per row rather than a batched
 * embeddings call, and self-terminates on a drained sweep.
 *
 * It only ever writes the `topic` column (never `content`), so a mislabel can't
 * damage the underlying fact — which is why the modest task model is safe here.
 *
 * Like the `…NeedingTopic` query, the sweep reads across all users — a background
 * job, not a request path, so the per-user read-isolation invariant doesn't apply.
 */

import { getTaskModel } from '../tasks/task-model';
import { generateMemoryTopic, fallbackTopic } from '../tasks/topic-generator';
import { listMemoriesNeedingTopic, setMemoryTopic } from '../db/queries/memories';

// One completion per row (topic gen can't batch cleanly like embeddings), so
// keep the per-sweep ceiling lower than the embedding backfiller's 400: 8 × 25 =
// up to 200 rows/sweep, the rest picked up on the next tick.
const BATCH_SIZE = 8;
const MAX_BATCHES_PER_SWEEP = 25;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
// A little after the embedding backfiller's 15s so a fresh boot doesn't fire
// both at the same instant.
const INITIAL_DELAY_MS = 20_000;

let timer: NodeJS.Timeout | null = null;
let running = false;
// Monotonic token identifying the current worker "generation". start() claims a
// fresh one; stop() bumps it (and a later start() bumps it again). A sweep
// already in flight captured its generation, so its completion callback — which
// clearTimeout can't cancel — can tell it's been superseded and leave the timer
// alone, rather than re-arming after a stop or clobbering a restart's timer. A
// shared boolean can't distinguish "stopped" from "stopped then restarted".
let generation = 0;

/**
 * Run one topic-backfill pass. Returns how many rows were filled and whether the
 * queue is now empty (`drained`) so the caller can stop rescheduling. No-op
 * (`filled: 0, drained: false`) when no task model is configured or a sweep is
 * already running. An upstream failure ends the sweep early, leaving rows for
 * next time (NOT reported as drained). Safe to call directly (tests).
 */
export async function runTopicBackfillSweep(): Promise<{ filled: number; drained: boolean }> {
	if (running) return { filled: 0, drained: false };
	running = true;
	try {
		const model = getTaskModel();
		if (!model) return { filled: 0, drained: false };

		let filled = 0;
		for (let batch = 0; batch < MAX_BATCHES_PER_SWEEP; batch++) {
			const rows = listMemoriesNeedingTopic(BATCH_SIZE);
			if (rows.length === 0) return { filled, drained: true };

			let progressed = 0;
			for (const row of rows) {
				let topic: string | null;
				try {
					topic = await generateMemoryTopic(model, row.content);
				} catch (e) {
					// Endpoint down / timeout — stop and leave the rest for the next
					// sweep rather than fallback-labelling everything while the model
					// is unavailable.
					console.warn('[topic-backfill] task model call failed, retrying next sweep:', e);
					return { filled, drained: false };
				}
				// Model returned nothing usable → content-derived fallback so the row
				// still drains (worst case its label ≈ the snippet the index showed).
				const label = topic ?? fallbackTopic(row.content);
				// Guarded write: skips if the content changed mid-generation or a
				// concurrent update_memory already set a real topic.
				if (setMemoryTopic(row.id, row.content, label)) {
					filled++;
					progressed++;
				}
			}
			// No row in this batch took (all lost a race) — stop rather than re-query
			// the same rows forever within one sweep.
			if (progressed === 0) break;
		}
		return { filled, drained: false };
	} finally {
		running = false;
	}
}

/**
 * Mount the periodic topic backfiller. Idempotent. No-op when no `task_model` is
 * configured — without one there's no way to generate labels, so a timer would
 * just wake to do nothing. Self-terminates once a sweep finds the queue empty:
 * nothing reintroduces null topics today (save_memory / update_memory always
 * supply one). A future feature that creates topic-less rows (e.g. phase-4
 * consolidation writing new memories) must call this again to re-arm — a plain
 * restart also re-runs it and re-checks.
 */
export function startTopicBackfiller(): void {
	if (timer) return;
	if (!getTaskModel()) return;
	const myGen = ++generation;
	function tick() {
		runTopicBackfillSweep().then(
			(r) => {
				if (generation !== myGen) return; // superseded by stop()/restart
				if (r.drained) {
					timer = null;
					console.log('[topic-backfill] backlog drained; worker stopped');
					return;
				}
				timer = setTimeout(tick, SWEEP_INTERVAL_MS);
				timer?.unref();
			},
			(e) => {
				console.error('[topic-backfill] sweep failed:', e);
				if (generation !== myGen) return; // superseded — don't re-arm
				timer = setTimeout(tick, SWEEP_INTERVAL_MS);
				timer?.unref();
			},
		);
	}
	timer = setTimeout(tick, INITIAL_DELAY_MS);
	timer?.unref();
	console.log(`[topic-backfill] started; sweep every ${SWEEP_INTERVAL_MS / 60000}min`);
}

/**
 * Tear down the timer — for tests / clean shutdown. Bumps the generation so a
 * sweep already in flight won't re-arm the timer from its completion callback
 * (`clearTimeout` can't cancel the pending promise continuation).
 */
export function stopTopicBackfiller(): void {
	generation++;
	if (timer) {
		clearTimeout(timer);
		timer = null;
	}
}
