import { sveltekit } from '@sveltejs/kit/vite';
import { svelteTesting } from '@testing-library/svelte/vite';
import { defineConfig } from 'vitest/config';

/**
 * Vitest config — kept separate from vite.config.ts so the production
 * build doesn't inherit test-only setup. Includes sveltekit() so test
 * files can import from `$lib/*` aliases the same way runtime code does.
 *
 * svelteTesting() flips resolve.conditions to prefer the 'browser'
 * export of Svelte over its SSR ('node') export, so testing-library's
 * mount() works rather than throwing `mount is not available on the
 * server`. It also auto-cleans the DOM after each test.
 */
export default defineConfig({
	plugins: [sveltekit(), svelteTesting()],
	test: {
		include: [
			'tests/unit/**/*.{test,spec}.{js,ts}',
			'tests/component/**/*.{test,spec}.{js,ts}'
		],
		// Default is "node" — most of our pure-logic tests don't need a DOM.
		// Component tests header with /* @vitest-environment happy-dom */
		// to flip the env per-file (see tests/component/README.md). happy-dom
		// over jsdom for speed + lighter footprint.
		environment: 'node',
		// Loaded for every test but only adds matchers; harmless to node-env
		// suites. Registers @testing-library/jest-dom extensions
		// (toBeInTheDocument, toHaveAttribute, ...) so component tests can
		// use them without per-file imports.
		setupFiles: ['./tests/component/_setup.ts'],
		// Run each test file in its own process so DB tests with global
		// connection state don't cross-contaminate. Cheap because the
		// suite is small.
		isolate: true,
		// Tolerate unhandled errors thrown OUTSIDE the test flow. The one
		// source today is bits-ui's dismissible-layer (Popover/Dialog/
		// Switch): it attaches a document pointerdown handler whose callback
		// is debounced 500ms. bits-ui DOES clear it on unmount, but under CI
		// timing a pending timer can fire just after the happy-dom env is
		// torn down, when the global `Element` no longer exists — throwing
		// "Element is not defined" deep inside bits-ui and failing the run
		// even though every assertion passed. It's a 3rd-party env-teardown
		// ordering artifact, not a fault in our code. This does NOT affect
		// test assertions — a real bug still fails its expect(); it only
		// stops a stray post-teardown async throw from failing CI.
		// (vitest exposes this as a root-only option, not per-project.)
		dangerouslyIgnoreUnhandledErrors: true
	}
});
