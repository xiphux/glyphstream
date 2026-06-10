/**
 * Tests for `composeSignals` — the AbortSignal combinator used wherever a
 * long-running op honors both a caller cancel signal and a local timeout
 * (chat-completion fetches, web_search, fetch_url, retrieval embedding).
 *
 * These lock the observable contract BEFORE the internal polyfill branch is
 * dropped in favor of native `AbortSignal.any` (the Node >=24 target always
 * has it), so the simplification can't change behavior:
 *   - 0 present signals → a signal that never aborts
 *   - exactly 1 present signal → returned by identity (no wrapper)
 *   - >=2 → aborts when ANY input aborts, propagating that input's reason
 *   - undefined inputs are filtered out
 */

import { describe, expect, it } from 'vitest';
import { composeSignals } from '$lib/server/util/abort';

describe('composeSignals — degenerate inputs', () => {
	it('returns a non-aborted signal when given no signals', () => {
		const s = composeSignals();
		expect(s).toBeInstanceOf(AbortSignal);
		expect(s.aborted).toBe(false);
	});

	it('returns a non-aborted signal when all inputs are undefined', () => {
		const s = composeSignals(undefined, undefined);
		expect(s.aborted).toBe(false);
	});

	it('returns the sole present signal by identity (no wrapping)', () => {
		const ctrl = new AbortController();
		expect(composeSignals(ctrl.signal)).toBe(ctrl.signal);
	});

	it('returns the sole present signal by identity even amid undefined inputs', () => {
		const ctrl = new AbortController();
		expect(composeSignals(undefined, ctrl.signal, undefined)).toBe(ctrl.signal);
	});
});

describe('composeSignals — composition', () => {
	it('aborts when the first input aborts, propagating its reason', () => {
		const a = new AbortController();
		const b = new AbortController();
		const composed = composeSignals(a.signal, b.signal);
		expect(composed.aborted).toBe(false);

		const reason = new Error('first cancelled');
		a.abort(reason);
		expect(composed.aborted).toBe(true);
		expect(composed.reason).toBe(reason);
	});

	it('aborts when the second input aborts', () => {
		const a = new AbortController();
		const b = new AbortController();
		const composed = composeSignals(a.signal, b.signal);
		b.abort(new Error('second cancelled'));
		expect(composed.aborted).toBe(true);
	});

	it('is already aborted synchronously when an input is pre-aborted', () => {
		const reason = new Error('already gone');
		const pre = AbortSignal.abort(reason);
		const live = new AbortController();
		const composed = composeSignals(live.signal, pre);
		expect(composed.aborted).toBe(true);
		expect(composed.reason).toBe(reason);
	});

	it('fires a single abort event to listeners when an input aborts', async () => {
		const a = new AbortController();
		const b = new AbortController();
		const composed = composeSignals(a.signal, b.signal);
		let count = 0;
		composed.addEventListener('abort', () => count++);
		a.abort();
		// Microtask flush so the event dispatch settles.
		await Promise.resolve();
		expect(count).toBe(1);
	});

	it('composes a caller signal with a timeout signal (the canonical call shape)', () => {
		const caller = new AbortController();
		const composed = composeSignals(caller.signal, AbortSignal.timeout(60_000));
		expect(composed.aborted).toBe(false);
		caller.abort();
		expect(composed.aborted).toBe(true);
	});
});
