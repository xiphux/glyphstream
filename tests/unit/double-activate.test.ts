/**
 * The debug panel's only entry point. If this breaks, the panel is either
 * unreachable or it fires on an ordinary single click in the sidebar header —
 * and since nothing in the UI points at the feature, neither failure would get
 * reported.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDoubleActivate } from '../../src/lib/double-activate';

describe('createDoubleActivate', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	const advance = (ms: number) => vi.advanceTimersByTime(ms);

	it('does nothing on a single activation', () => {
		const onDouble = vi.fn();
		createDoubleActivate(onDouble)();
		expect(onDouble).not.toHaveBeenCalled();
	});

	it('fires on a second activation inside the window', () => {
		const onDouble = vi.fn();
		const activate = createDoubleActivate(onDouble);
		activate();
		advance(200);
		activate();
		expect(onDouble).toHaveBeenCalledTimes(1);
	});

	it('does not fire when the second activation is too late', () => {
		const onDouble = vi.fn();
		const activate = createDoubleActivate(onDouble, 450);
		activate();
		advance(600);
		activate();
		expect(onDouble).not.toHaveBeenCalled();
	});

	it('starts a fresh pair after firing, rather than firing on every click', () => {
		// Without the reset, the timestamp from the second click would still be
		// recent and a third click would re-open immediately — which reads as
		// "clicking the version toggles a dialog", the opposite of hidden.
		const onDouble = vi.fn();
		const activate = createDoubleActivate(onDouble);
		activate();
		advance(100);
		activate(); // fires
		advance(100);
		activate(); // must NOT fire — this is the start of a new pair
		expect(onDouble).toHaveBeenCalledTimes(1);
		advance(100);
		activate(); // completes the new pair
		expect(onDouble).toHaveBeenCalledTimes(2);
	});

	it('treats a slow triple as one pair plus a lone click', () => {
		const onDouble = vi.fn();
		const activate = createDoubleActivate(onDouble, 450);
		activate();
		advance(100);
		activate(); // fires
		advance(1000);
		activate(); // far too late to pair with anything
		expect(onDouble).toHaveBeenCalledTimes(1);
	});
});
