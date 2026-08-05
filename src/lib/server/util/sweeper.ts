/**
 * Shared lifecycle for the periodic background workers (media purger, embedding
 * backfiller, topic backfiller, dreaming, conversation summaries).
 *
 * Every one of them independently grew the same skeleton — a recursive
 * `setTimeout` chain, an idempotent `start`, a `stop` that tears the timer down —
 * and their comments said so out loud ("Mirrors the media purger's shape",
 * "Worker skeleton mirrors `dreaming.ts`"). Copying it also let the copies drift:
 * three had a generation token and two didn't, which is a real bug (see below).
 * One implementation removes the drift by construction.
 *
 * ## Why a generation token, not just `clearTimeout`
 *
 * A tick is `sweep().finally(() => timer = setTimeout(tick, …))`. If `stop()`
 * lands while a sweep is in flight, `clearTimeout` cannot cancel the pending
 * promise continuation — it has no timer to cancel yet. The `.finally` runs
 * afterwards and re-arms a worker that was supposed to be stopped. A later
 * `start()` then makes it worse: the stale continuation overwrites `timer` with
 * its own handle, orphaning the new one, so two tick chains are live and `stop()`
 * can only ever cancel one.
 *
 * A monotonic generation fixes it. `start()` claims a fresh one; `stop()` bumps
 * it. A tick captured its generation at schedule time, so its continuation can
 * tell it has been superseded and decline to re-arm. A plain boolean can't — it
 * cannot distinguish "stopped" from "stopped, then started again".
 *
 * ## What stays with the caller
 *
 * The re-entrancy guard (`if (running) return`) deliberately stays inside each
 * `runXSweep`. Those functions are exported and called directly by tests, and the
 * guard is part of *their* contract ("safe to call directly even with the timer
 * running"). Hoisting it here would leave direct calls unguarded.
 */

export interface SweeperOptions<T> {
	/** Log prefix, without brackets — e.g. `purger` logs as `[purger]`. */
	name: string;
	/** Delay between the end of one sweep and the start of the next. */
	intervalMs: number;
	/**
	 * Delay before the first sweep. Kept short relative to `intervalMs` so a
	 * process restart doesn't have to wait a full interval to catch up on work
	 * that fell due during the downtime.
	 */
	initialDelayMs: number;
	/**
	 * Gate checked once at `start()`. Returning false makes start a no-op — used
	 * where the worker needs configuration that may be absent (no task model, no
	 * embeddings endpoint), so a timer would only ever wake to do nothing. A
	 * config change needs a restart, which re-runs the check.
	 */
	enabled?: () => boolean;
	/** One pass. Rejections are logged and the worker re-arms. */
	sweep: () => Promise<T>;
	/**
	 * Optional self-termination. When it returns true the worker stops for good
	 * instead of rescheduling — for finite backlogs where nothing reintroduces
	 * work. Never consulted when the sweep rejected (there's no result, and a
	 * failure isn't a drained queue).
	 */
	isDrained?: (result: T) => boolean;
	/** Appended to the start log line, for workers with extra knobs worth stating. */
	startedDetail?: string;
}

export interface Sweeper {
	/** Mount the timer. Idempotent, and a no-op when `enabled` returns false. */
	start(): void;
	/** Tear down. Safe during an in-flight sweep — it won't re-arm. */
	stop(): void;
}

export function createSweeper<T>(opts: SweeperOptions<T>): Sweeper {
	const { name, intervalMs, initialDelayMs, enabled, sweep, isDrained, startedDetail } = opts;

	let timer: NodeJS.Timeout | null = null;
	let generation = 0;

	/** Arm the next tick, unless this chain has been superseded by stop/restart. */
	function rearm(myGen: number, tick: () => void): void {
		if (generation !== myGen) return;
		timer = setTimeout(tick, intervalMs);
		// Never hold the event loop open — a pending sweep must not stop the
		// process from exiting on SIGTERM.
		timer?.unref();
	}

	return {
		start(): void {
			if (timer) return;
			if (enabled && !enabled()) return;
			const myGen = ++generation;

			function tick(): void {
				sweep().then(
					(result) => {
						if (generation !== myGen) return;
						if (isDrained?.(result)) {
							timer = null;
							console.log(`[${name}] backlog drained; worker stopped`);
							return;
						}
						rearm(myGen, tick);
					},
					(e) => {
						console.error(`[${name}] sweep failed:`, e);
						rearm(myGen, tick);
					},
				);
			}

			timer = setTimeout(tick, initialDelayMs);
			timer?.unref();
			console.log(
				`[${name}] started; sweep every ${intervalMs / 60000}min${
					startedDetail ? `, ${startedDetail}` : ''
				}`,
			);
		},

		stop(): void {
			// Bump first: an in-flight sweep's continuation checks this, and it's the
			// only thing that can stop it re-arming.
			generation++;
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
		},
	};
}
