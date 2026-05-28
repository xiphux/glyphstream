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
import '@testing-library/jest-dom/vitest';

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
