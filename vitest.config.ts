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
		isolate: true
	}
});
