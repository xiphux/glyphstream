/**
 * Global vitest setup for component tests.
 *
 * Loaded by `setupFiles` in vitest.config.ts and runs before every test
 * file — both component tests and the pure-logic unit suite. The single
 * matcher import registers @testing-library/jest-dom's matchers
 * (toBeInTheDocument, toHaveAttribute, toHaveTextContent, ...) onto
 * vitest's expect, so component test files don't have to import it
 * themselves.
 *
 * Safe to load for non-DOM tests — only adds matchers + a console.warn
 * filter; doesn't run any DOM-dependent code at import time.
 */
import { afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';

/**
 * Cancel any setTimeout still pending when a component test ends.
 *
 * bits-ui's dismissible-layer (Popover / Switch) attaches a document
 * pointerdown handler whose callback is debounced 500ms. Under CI timing
 * a pending timer can fire just after vitest tears the happy-dom env
 * down — at which point the global `Element` no longer exists, so
 * bits-ui's `e.target instanceof Element` throws
 * "ReferenceError: Element is not defined", crashing the run even though
 * every assertion passed. (vitest's dangerouslyIgnoreUnhandledErrors
 * doesn't help — it covers unhandled rejections, not uncaught exceptions
 * thrown from a timer callback.)
 *
 * We wrap setTimeout/clearTimeout to track live timers and cancel any
 * leftover in afterEach, so no real timer survives a test into teardown.
 * vitest clears its own per-test timers via clearTimeout (which we
 * untrack), so what remains is genuine leaks — safe to cancel.
 *
 * Scoped to the DOM env (`window` defined) so the node-env unit suite —
 * which relies on real timers (AbortSignal.timeout, ordering delays) —
 * is untouched. Remove when bits-ui stops leaking the timer past unmount.
 */
if (typeof window !== 'undefined') {
	type TimerId = ReturnType<typeof globalThis.setTimeout>;
	const pending = new Set<TimerId>();
	const realSetTimeout = globalThis.setTimeout;
	const realClearTimeout = globalThis.clearTimeout;
	globalThis.setTimeout = ((...args: Parameters<typeof globalThis.setTimeout>) => {
		const id = realSetTimeout(...args);
		pending.add(id);
		return id;
	}) as typeof setTimeout;
	globalThis.clearTimeout = ((...args: Parameters<typeof globalThis.clearTimeout>) => {
		const id = args[0];
		if (id !== undefined) pending.delete(id as TimerId);
		return realClearTimeout(...args);
	}) as typeof clearTimeout;
	afterEach(() => {
		for (const id of pending) realClearTimeout(id);
		pending.clear();
	});
}

/**
 * Filter out Svelte 5's `derived_inert` warnings, which fire spuriously
 * during bits-ui Popover / Switch teardown in the test environment.
 *
 * The warning means "a $derived inside a now-destroyed effect was read,
 * may return a stale value" — which is genuinely harmless when the
 * component is mid-teardown (nothing observable reads the stale value),
 * but bits-ui's internal lifecycle triggers it dozens of times per
 * interaction in happy-dom because cleanup ordering is synchronous.
 *
 * Filtering this one warning by string match keeps stderr useful: real
 * warnings — including any `derived_inert` we'd produce in code we
 * actually wrote — would still surface in dev / browser. Anything that
 * isn't this specific message passes through unchanged.
 *
 * Remove when bits-ui >= the version that addresses it, or when Svelte
 * relaxes the warning's emit conditions in test environments.
 */
const originalWarn = console.warn;
console.warn = (...args: unknown[]) => {
	const first = args[0];
	if (typeof first === 'string' && first.includes('derived_inert')) return;
	originalWarn(...args);
};
