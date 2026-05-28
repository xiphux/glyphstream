/**
 * Global vitest setup for component tests.
 *
 * Loaded by `setupFiles` in vitest.config.ts and runs before every test
 * file — both component tests and the pure-logic unit suite. The single
 * import registers @testing-library/jest-dom's matchers
 * (toBeInTheDocument, toHaveAttribute, toHaveTextContent, ...) onto
 * vitest's expect, so component test files don't have to import it
 * themselves.
 *
 * Safe to load for non-DOM tests — only adds matchers; doesn't run any
 * DOM-dependent code at import time.
 */
import '@testing-library/jest-dom/vitest';
