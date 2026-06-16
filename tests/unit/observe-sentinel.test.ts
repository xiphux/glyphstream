import { afterEach, describe, expect, it, vi } from 'vitest';
import { observeSentinel } from '$lib/observe-sentinel';

// Minimal IntersectionObserver stand-in: capture the callback + options and let
// the test fire intersection changes by hand.
class FakeIO {
	static last: FakeIO | null = null;
	cb: IntersectionObserverCallback;
	options: IntersectionObserverInit | undefined;
	observed: Element[] = [];
	disconnected = false;
	constructor(cb: IntersectionObserverCallback, options?: IntersectionObserverInit) {
		this.cb = cb;
		this.options = options;
		FakeIO.last = this;
	}
	observe(el: Element) {
		this.observed.push(el);
	}
	disconnect() {
		this.disconnected = true;
	}
	fire(isIntersecting: boolean) {
		this.cb(
			[{ isIntersecting } as IntersectionObserverEntry],
			this as unknown as IntersectionObserver,
		);
	}
}

afterEach(() => {
	FakeIO.last = null;
	vi.unstubAllGlobals();
});

const el = (): HTMLElement => ({}) as HTMLElement;

describe('observeSentinel', () => {
	it('returns a no-op (and never constructs an observer) when an element is missing', () => {
		vi.stubGlobal('IntersectionObserver', FakeIO);
		const onVisible = vi.fn();
		expect(observeSentinel(null, el(), onVisible)).toBeTypeOf('function');
		expect(observeSentinel(el(), null, onVisible)).toBeTypeOf('function');
		expect(FakeIO.last).toBeNull();
		expect(onVisible).not.toHaveBeenCalled();
	});

	it('observes the sentinel within the root, reports visibility, and applies rootMargin', () => {
		vi.stubGlobal('IntersectionObserver', FakeIO);
		const root = el();
		const sentinel = el();
		const onVisible = vi.fn();

		observeSentinel(root, sentinel, onVisible, { rootMargin: '0px 0px 400px 0px' });

		const io = FakeIO.last!;
		expect(io.observed).toEqual([sentinel]);
		expect(io.options).toMatchObject({ root, rootMargin: '0px 0px 400px 0px', threshold: 0 });

		io.fire(true);
		io.fire(false);
		expect(onVisible.mock.calls).toEqual([[true], [false]]);
	});

	it('disconnects the observer on cleanup', () => {
		vi.stubGlobal('IntersectionObserver', FakeIO);
		const cleanup = observeSentinel(el(), el(), vi.fn());
		expect(FakeIO.last!.disconnected).toBe(false);
		cleanup();
		expect(FakeIO.last!.disconnected).toBe(true);
	});

	it('defaults rootMargin to 0px when none is given', () => {
		vi.stubGlobal('IntersectionObserver', FakeIO);
		observeSentinel(el(), el(), vi.fn());
		expect(FakeIO.last!.options?.rootMargin).toBe('0px');
	});
});
