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
 * server`.
 *
 * Its `autoCleanup` is off, and the component project lists the cleanup
 * file itself: the plugin adds that file to the ROOT config's setupFiles,
 * and since vitest 5 a setup file added that way no longer reaches the
 * projects below. Every component test then rendered into the leftovers of
 * the one before it (400 "Found multiple elements" failures).
 */
export default defineConfig({
	plugins: [sveltekit(), svelteTesting({ autoCleanup: false })],
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
			// vite-plugin-pwa only runs in vite.config.ts, so this virtual module
			// has no resolver here. The root layout imports it dynamically behind
			// `import.meta.env.PROD` and never evaluates it under test — but Vite
			// resolves the specifier at transform time regardless, so without this
			// the layout can't even be loaded by a component test.
			'virtual:pwa-register': fileURLToPath(
				new URL('./tests/_stubs/pwa-register.ts', import.meta.url),
			),
		},
	},
	test: {
		// The environment follows the directory, not a per-file header. Headers
		// were the old mechanism, and a component test that forgot one ran under
		// `node` and failed confusingly (`document is not defined`, or DOM
		// queries silently missing). Everything above and below this block is
		// shared: `extends: true` gives each project the root plugins, aliases
		// and test options. A header still overrides per file — the few
		// `tests/unit` files that need a DOM but aren't component tests use one.
		// happy-dom over jsdom for speed + lighter footprint.
		// Run one side with `pnpm test --project unit` / `--project component`.
		projects: [
			{
				extends: true,
				test: {
					name: 'unit',
					include: ['tests/unit/**/*.{test,spec}.{js,ts}'],
					environment: 'node',
				},
			},
			{
				extends: true,
				test: {
					name: 'component',
					include: ['tests/component/**/*.{test,spec}.{js,ts}'],
					environment: 'happy-dom',
					// Unmounts + empties the DOM after each test. See the note above.
					setupFiles: ['@testing-library/svelte/vitest'],
				},
			},
		],
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
		// Run each test file in its own worker so DB tests with global
		// connection state don't cross-contaminate. `isolate: false` really
		// does leak here: run twice in shuffled file order, it fails.
		isolate: true,
		// Worker threads rather than the default forked processes: still one
		// isolated worker per file, as above, but cheaper to start. Measured
		// over five runs each: 44s -> 38s (-14%), all passing.
		//
		// Not a vm pool (vmThreads/vmForks), which vitest doctor measures as
		// faster elsewhere: here both fail, because tests/unit/vision-variant
		// times out running sharp inside a VM context. And in heatsheet-io
		// and football, both vm pools segfaulted intermittently with coverage
		// on — about one run in ten. Plain threads involve no VM contexts.
		// `npx vitest doctor` re-measures all of this.
		pool: 'threads',
	},
});
