import { sveltekit } from '@sveltejs/kit/vite';
import { sveltekitOptions } from './sveltekit.config.ts';
import { svelteTesting } from '@testing-library/svelte/vite';
import { defineConfig } from 'vitest/config';

/**
 * Vitest config — kept separate from vite.config.ts so the production
 * build doesn't inherit test-only setup. Includes sveltekit(), with the app's
 * own options (sveltekit.config.ts), so components compile exactly as they do
 * in the build.
 *
 * svelteTesting() (component project only) flips resolve.conditions to
 * prefer the 'browser' export of Svelte over its SSR ('node') export, so
 * testing-library's mount() works rather than throwing `mount is not
 * available on the server`.
 *
 * Its `autoCleanup` is off, and the component project lists the cleanup
 * file itself: the plugin adds that file to the ROOT config's setupFiles,
 * and since vitest 5 a setup file added that way no longer reaches the
 * projects below. Every component test then rendered into the leftovers of
 * the one before it (400 "Found multiple elements" failures).
 */
export default defineConfig({
	plugins: [sveltekit(sveltekitOptions)],
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
				// Here, not at the root: its 'browser' resolution reaches every module,
				// and `tests/unit` exercises SERVER code. There it swapped in Kit's
				// client build of `redirect()`'s origin check, which reads `window`
				// — and since SvelteKit 3 validates every redirect target, every
				// unit test that hit a redirect died on `window is not defined`.
				plugins: [svelteTesting({ autoCleanup: false })],
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
		// Lands because $lib/server/env.ts reads process.env, which this sets.
		// (It didn't while env.ts read Kit's `$env/dynamic/private`, empty under
		// vitest; config-isolation.test.ts guards against that coming back.)
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
