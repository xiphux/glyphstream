import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

/**
 * Vitest config — kept separate from vite.config.ts so the production
 * build doesn't inherit test-only setup. Includes sveltekit() so test
 * files can import from `$lib/*` aliases the same way runtime code does.
 */
export default defineConfig({
	plugins: [sveltekit()],
	test: {
		include: ['tests/unit/**/*.{test,spec}.{js,ts}'],
		// Default is "jsdom" or "happy-dom" — most of our pure-logic tests
		// don't need a DOM, so default to node and let test files override
		// with /* @vitest-environment jsdom */ at the top when needed.
		environment: 'node',
		// Run each test file in its own process so DB tests with global
		// connection state don't cross-contaminate. Cheap because the
		// suite is small.
		isolate: true
	}
});
