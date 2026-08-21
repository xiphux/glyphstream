/**
 * Event-loop stall sampling, for the debug panel's `lag` field.
 *
 * Read WITH `cpu`, not instead of it. Neither number means much alone; the pair
 * splits the slow request three ways:
 *
 *   stalled + high cpu — synchronous JavaScript held the loop. Process-wide
 *     counters can't say whose: this request's own render, or a sweeper's batch
 *     that it was queued behind. Either way the fix is to stop doing that work
 *     synchronously.
 *   stalled + LOW cpu — the loop was blocked without burning CPU, which means a
 *     blocking syscall. `node:sqlite` is synchronous, so a read that misses the
 *     page cache and goes to the volume stalls the whole process for the length
 *     of the physical I/O while spending almost no CPU. This is the signature
 *     the whole investigation is looking for, and it is invisible to `cpu`,
 *     which reads near-zero for it, exactly like an idle server.
 *   not stalled + low cpu — this request waited on something that left the loop
 *     free, such as an awaited network call.
 *
 * Host descheduling belongs in the SECOND bucket, not the third: `performance.now()`
 * keeps advancing while the container is denied CPU, so a deschedule long enough
 * to explain a slow request overshoots the tick and reads as a stall like any
 * other. Only jitter too brief to overshoot the sample interval hides here.
 *
 * Sampled on a timer rather than measured per request, because a blocked loop is
 * by definition not running the code that would measure it. A recurring timer
 * that fails to fire on schedule IS the measurement: the overshoot past its own
 * interval is how long the loop was unavailable.
 */

/** How often to sample. Fine enough to catch a stall worth naming, coarse
 *  enough that the wakeups are irrelevant next to the work being diagnosed. */
export const SAMPLE_INTERVAL_MS = 100;

/** ~60s of history. A slow load is single-digit seconds, so this is generous;
 *  it's a fixed two Float64Arrays either way, allocated once. */
const CAPACITY = 600;

export interface LagWindow {
	/** Record a tick that landed at `at` having taken `observedIntervalMs`. */
	record(at: number, observedIntervalMs: number): void;
	/**
	 * Longest stall overlapping [`since`, `now`], in ms.
	 *
	 * `now` is not decoration. A stall that is still unwinding has not been
	 * recorded yet — when the loop frees up it may run this request's own
	 * continuation (a microtask) before the sampler's timer callback, so reading
	 * only the ring would report zero for the very stall that caused the delay.
	 * The gap between the last recorded tick and `now` closes that hole.
	 */
	maxSince(since: number, now: number): number;
}

export function createLagWindow(intervalMs = SAMPLE_INTERVAL_MS, capacity = CAPACITY): LagWindow {
	const at = new Float64Array(capacity);
	const lag = new Float64Array(capacity);
	let next = 0;
	// Guarded explicitly rather than seeded with a sentinel timestamp: every
	// sentinel makes the "still stalling" term below wrong in one direction or
	// the other before the first tick lands — 0 reports the whole process
	// lifetime as a stall, -Infinity reports an infinite one.
	let lastTickAt = 0;
	let seen = false;

	return {
		record(tickAt, observedIntervalMs) {
			at[next] = tickAt;
			// Only the overshoot is a stall; the interval itself is by design.
			lag[next] = Math.max(0, observedIntervalMs - intervalMs);
			next = (next + 1) % capacity;
			lastTickAt = tickAt;
			seen = true;
		},
		maxSince(since, now) {
			let max = 0;
			for (let i = 0; i < capacity; i++) {
				// A tick recorded at T reports a stall that ended at T, so it counts
				// for any window still open at T.
				if (at[i] >= since && lag[i] > max) max = lag[i];
			}
			const stillStalling = seen ? now - lastTickAt - intervalMs : 0;
			return Math.max(0, max, stillStalling);
		},
	};
}

const window_ = createLagWindow();
let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Start sampling. Idempotent, and `unref`'d so it never holds the process open —
 * the alternative is another entry in the shutdown handler, and a diagnostic
 * should not be able to delay a deploy.
 */
export function startLoopLagSampler(): void {
	if (timer) return;
	let prev = performance.now();
	timer = setInterval(() => {
		const now = performance.now();
		window_.record(now, now - prev);
		prev = now;
	}, SAMPLE_INTERVAL_MS);
	timer.unref();
}

/** Longest event-loop stall overlapping this request's span, in ms. */
export function maxLoopLagSince(since: number): number {
	return window_.maxSince(since, performance.now());
}
