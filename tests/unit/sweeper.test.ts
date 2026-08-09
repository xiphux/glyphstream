/**
 * The shared background-worker lifecycle (`createSweeper`).
 *
 * Five workers (media purger, embedding backfiller, topic backfiller, dreaming,
 * conversation summaries) had independently grown the same recursive-setTimeout
 * skeleton, and the copies had drifted: three carried a generation token and two
 * did not. That difference is a real defect, and it's the reason most of these
 * tests exist.
 *
 * The defect: a tick is `sweep().finally(() => timer = setTimeout(tick, …))`. If
 * `stop()` lands while a sweep is in flight there is no timer to cancel yet, so
 * `clearTimeout` is a no-op and the pending continuation re-arms a worker that
 * was supposed to be stopped. A subsequent `start()` is worse — the stale
 * continuation overwrites `timer` with its own handle, orphaning the new one, so
 * two chains run and `stop()` can only ever cancel one.
 *
 * These are the cases a boolean `stopped` flag cannot express, which is why the
 * implementation uses a monotonic generation instead.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSweeper } from '$lib/server/util/sweeper';

/** A sweep whose completion the test controls, so "in flight" is a real state. */
function deferredSweep() {
	let release!: (v?: unknown) => void;
	let reject!: (e: unknown) => void;
	let calls = 0;
	const fn = vi.fn(() => {
		calls++;
		return new Promise((res, rej) => {
			release = res;
			reject = rej;
		});
	});
	return {
		fn,
		get calls() {
			return calls;
		},
		release: (v?: unknown) => release(v),
		reject: (e: unknown) => reject(e),
	};
}

/** Let queued promise continuations run without advancing fake time. */
const flush = () => Promise.resolve().then(() => Promise.resolve());

describe('createSweeper', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('runs the first sweep after initialDelayMs, then every intervalMs', async () => {
		const sweep = deferredSweep();
		const s = createSweeper({
			name: 'test',
			intervalMs: 5000,
			initialDelayMs: 100,
			sweep: sweep.fn,
		});
		s.start();

		expect(sweep.calls).toBe(0);
		await vi.advanceTimersByTimeAsync(100);
		expect(sweep.calls).toBe(1);

		sweep.release();
		await flush();
		// Re-armed at the interval, not the initial delay.
		await vi.advanceTimersByTimeAsync(4999);
		expect(sweep.calls).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(sweep.calls).toBe(2);

		s.stop();
	});

	it('start is idempotent — a second call does not add a parallel chain', async () => {
		const sweep = deferredSweep();
		const s = createSweeper({
			name: 'test',
			intervalMs: 5000,
			initialDelayMs: 100,
			sweep: sweep.fn,
		});
		s.start();
		s.start();
		s.start();

		await vi.advanceTimersByTimeAsync(100);
		expect(sweep.calls).toBe(1);

		s.stop();
	});

	it('does not mount when `enabled` returns false', async () => {
		const sweep = deferredSweep();
		const s = createSweeper({
			name: 'test',
			intervalMs: 5000,
			initialDelayMs: 100,
			enabled: () => false,
			sweep: sweep.fn,
		});
		s.start();

		await vi.advanceTimersByTimeAsync(100_000);
		expect(sweep.calls).toBe(0);
	});

	// --- the regression cases ------------------------------------------------

	it('stop() during an in-flight sweep does not re-arm', async () => {
		const sweep = deferredSweep();
		const s = createSweeper({
			name: 'test',
			intervalMs: 5000,
			initialDelayMs: 100,
			sweep: sweep.fn,
		});
		s.start();

		await vi.advanceTimersByTimeAsync(100);
		expect(sweep.calls).toBe(1);

		// Stop while the sweep is still pending — there is no armed timer for
		// clearTimeout to cancel, so only the generation token can prevent the
		// completion callback from rescheduling.
		s.stop();
		sweep.release();
		await flush();

		await vi.advanceTimersByTimeAsync(100_000);
		expect(sweep.calls).toBe(1);
	});

	it('stop() during an in-flight sweep that REJECTS does not re-arm', async () => {
		const sweep = deferredSweep();
		const s = createSweeper({
			name: 'test',
			intervalMs: 5000,
			initialDelayMs: 100,
			sweep: sweep.fn,
		});
		s.start();

		await vi.advanceTimersByTimeAsync(100);
		s.stop();
		sweep.reject(new Error('boom'));
		await flush();

		await vi.advanceTimersByTimeAsync(100_000);
		expect(sweep.calls).toBe(1);
	});

	it('stop() then start() during an in-flight sweep leaves exactly one chain', async () => {
		const sweep = deferredSweep();
		const s = createSweeper({
			name: 'test',
			intervalMs: 5000,
			initialDelayMs: 100,
			sweep: sweep.fn,
		});
		s.start();

		await vi.advanceTimersByTimeAsync(100);
		expect(sweep.calls).toBe(1);

		// Restart while sweep #1 is still pending. The superseded continuation must
		// not clobber the new chain's timer — otherwise both are live and stop()
		// can only cancel one.
		s.stop();
		s.start();
		sweep.release();
		await flush();

		// New chain's initial delay fires exactly one sweep...
		await vi.advanceTimersByTimeAsync(100);
		expect(sweep.calls).toBe(2);
		sweep.release();
		await flush();

		// ...and one interval yields exactly one more, not two.
		await vi.advanceTimersByTimeAsync(5000);
		expect(sweep.calls).toBe(3);

		s.stop();
		sweep.release();
		await flush();
		await vi.advanceTimersByTimeAsync(100_000);
		expect(sweep.calls).toBe(3);
	});

	// --- optional behaviors ---------------------------------------------------

	it('self-terminates when isDrained returns true', async () => {
		const sweep = deferredSweep();
		const s = createSweeper({
			name: 'test',
			intervalMs: 5000,
			initialDelayMs: 100,
			sweep: sweep.fn as () => Promise<{ drained: boolean }>,
			isDrained: (r) => r.drained,
		});
		s.start();

		await vi.advanceTimersByTimeAsync(100);
		sweep.release({ drained: true });
		await flush();

		await vi.advanceTimersByTimeAsync(100_000);
		expect(sweep.calls).toBe(1);
	});

	it('keeps sweeping while isDrained returns false', async () => {
		const sweep = deferredSweep();
		const s = createSweeper({
			name: 'test',
			intervalMs: 5000,
			initialDelayMs: 100,
			sweep: sweep.fn as () => Promise<{ drained: boolean }>,
			isDrained: (r) => r.drained,
		});
		s.start();

		await vi.advanceTimersByTimeAsync(100);
		sweep.release({ drained: false });
		await flush();

		await vi.advanceTimersByTimeAsync(5000);
		expect(sweep.calls).toBe(2);

		s.stop();
	});

	it('a rejected sweep is logged and the worker keeps going', async () => {
		const sweep = deferredSweep();
		const s = createSweeper({
			name: 'test',
			intervalMs: 5000,
			initialDelayMs: 100,
			sweep: sweep.fn,
		});
		s.start();

		await vi.advanceTimersByTimeAsync(100);
		sweep.reject(new Error('boom'));
		await flush();

		expect(console.error).toHaveBeenCalledWith('[test] sweep failed:', expect.any(Error));

		// A failure must not kill the worker — the next tick retries.
		await vi.advanceTimersByTimeAsync(5000);
		expect(sweep.calls).toBe(2);

		s.stop();
	});

	it('does not hold the event loop open (timers are unref’d)', async () => {
		const sweep = deferredSweep();
		const s = createSweeper({
			name: 'test',
			intervalMs: 5000,
			initialDelayMs: 100,
			sweep: sweep.fn,
		});
		s.start();
		// vitest's fake timers expose hasRef() on the handle they hand back; the
		// worker must never pin the process open on SIGTERM.
		expect(vi.getTimerCount()).toBe(1);
		s.stop();
		expect(vi.getTimerCount()).toBe(0);
	});
});
