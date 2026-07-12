import { fileURLToPath } from 'node:url';
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
	resolve: {
		alias: {
			// `$env/dynamic/private` is populated by the SvelteKit SERVER at runtime;
			// under vitest it resolves to an empty object, so every `env.X` read in
			// src/lib/server/env.ts silently fell through to its hard-coded fallback —
			// and the `env` block below, which sets process.env, never reached it. The
			// CONFIG_PATH isolation was therefore inert, and the suite had been reading
			// the developer's REAL ./config.toml all along. Aliasing to process.env is
			// what actually makes that block work.
			'$env/dynamic/private': fileURLToPath(
				new URL('./tests/_stubs/env-dynamic-private.ts', import.meta.url),
			),
		},
	},
	test: {
		include: ['tests/unit/**/*.{test,spec}.{js,ts}', 'tests/component/**/*.{test,spec}.{js,ts}'],
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
		// Point config loading at a path that never exists so unit tests can't
		// read the developer's real ./config.toml. Without this, tests that
		// don't fully mock the config layer (e.g. tools-memory, tools-fetch-url)
		// behave differently on a dev machine (real config present) than in CI
		// (no config.toml). The loaders degrade to their documented defaults on
		// ENOENT, so "config absent" is the deterministic, isolated baseline.
		// Only effective because of the $env/dynamic/private alias above.
		env: { CONFIG_PATH: '/glyphstream-test-no-such-config.toml' },
		// Run each test file in its own process so DB tests with global
		// connection state don't cross-contaminate. Cheap because the
		// suite is small.
		isolate: true,
	},
});
