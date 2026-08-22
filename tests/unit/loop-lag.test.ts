/**
 * The stall window behind the debug panel's `Event loop` row.
 *
 * Exercised through the exported factory with explicit timestamps rather than
 * through the module singleton and a real timer: the interesting cases are a
 * stall that has not been recorded yet and a ring that has wrapped, and neither
 * is reachable by waiting.
 */
import { describe, expect, it } from 'vitest';
import { createLagWindow } from '../../src/lib/server/util/loop-lag';

describe('createLagWindow', () => {
	it('reports no stall when ticks land on schedule', () => {
		const w = createLagWindow(100, 10);
		for (let i = 1; i <= 5; i++) w.record(i * 100, 100);
		expect(w.maxSince(0, 500)).toBe(0);
	});

	it('counts only the overshoot, not the interval itself', () => {
		// A tick that took 400ms on a 100ms schedule means the loop was
		// unavailable for 300 of them. Reporting 400 would make an idle server
		// look permanently stalled.
		const w = createLagWindow(100, 10);
		w.record(100, 100);
		w.record(500, 400);
		expect(w.maxSince(0, 500)).toBe(300);
	});

	it('ignores stalls that ended before the window opened', () => {
		const w = createLagWindow(100, 10);
		w.record(200, 900); // an 800ms stall, long over
		w.record(1000, 100);
		expect(w.maxSince(900, 1000)).toBe(0);
	});

	it('sees a stall that is still unwinding and has not been recorded', () => {
		// The case the ring alone cannot cover: the loop frees up and runs this
		// request's continuation before the sampler's own timer callback, so the
		// stall that caused the delay is not in the ring yet when we read it.
		const w = createLagWindow(100, 10);
		w.record(100, 100);
		expect(w.maxSince(100, 2_600)).toBe(2_400);
	});

	it('clips a stall that began before the window opened', () => {
		// A tick taking 600ms on a 100ms schedule is a 500ms stall. It ended at
		// t=1000, but the window only opened at t=900, so
		// this request witnessed 100ms of it. Reporting the full 600 against a
		// request that could not have been alive for it is how a stall ends up
		// longer than the request containing it — which reads as a broken gauge and
		// costs the row its credibility.
		const w = createLagWindow(100, 10);
		w.record(1_000, 600);
		expect(w.maxSince(900, 1_000)).toBe(100);
	});

	it('still reports a stall fully inside the window at full length', () => {
		// The clipping must not shave anything off the case that matters most.
		const w = createLagWindow(100, 10);
		w.record(1_000, 600);
		expect(w.maxSince(0, 1_000)).toBe(500);
	});

	it('clips the still-unwinding stall to the window too', () => {
		// Same reasoning on the tail: the loop has been stuck since the tick that
		// was due at 200, but a window opened at 1_000 only saw from there.
		const w = createLagWindow(100, 10);
		w.record(100, 100);
		expect(w.maxSince(1_000, 2_600)).toBe(1_600);
	});

	it('does not invent a stall before the first tick ever lands', () => {
		// Nothing recorded yet must not read as "stalled since the epoch" — that
		// would make every request on a young process look catastrophic.
		const w = createLagWindow(100, 10);
		expect(w.maxSince(0, 5_000)).toBe(0);
	});

	it('keeps reporting correctly after the ring wraps', () => {
		const w = createLagWindow(100, 4);
		w.record(100, 900); // 800ms stall, will be overwritten
		for (let i = 2; i <= 9; i++) w.record(i * 100, 100);
		expect(w.maxSince(0, 900)).toBe(0);
	});

	it('takes the largest stall in the window, not the most recent', () => {
		const w = createLagWindow(100, 10);
		w.record(100, 100);
		w.record(600, 500); // 400ms
		w.record(800, 200); // 100ms
		expect(w.maxSince(0, 800)).toBe(400);
	});
});
