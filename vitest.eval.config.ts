import { sveltekit } from '@sveltejs/kit/vite';
import { sveltekitOptions } from './sveltekit.config.ts';
import { defineConfig } from 'vitest/config';

/**
 * Separate config for on-demand evaluation harnesses under `tests/eval/`.
 *
 * Evals are NOT part of `pnpm test`: they hit live endpoints (the configured
 * `[embeddings]` / `[rerank]` models from config.toml), are non-deterministic,
 * and measure quality rather than asserting pass/fail. Keeping them out of the
 * hermetic unit suite keeps CI deterministic. Run with `pnpm eval`.
 *
 * sveltekit() is included, with the app's own options (sveltekit.config.ts), so
 * the harness resolves modules exactly the way the app does — the eval drives
 * the real retrieval pipeline.
 */
export default defineConfig({
	plugins: [sveltekit(sveltekitOptions)],
	test: {
		include: ['tests/eval/**/*.eval.ts'],
		environment: 'node',
		// Live embedding + rerank round-trips per case; give the run room.
		testTimeout: 120_000,
		isolate: true,
		// The eval's value IS its console report — print it straight through
		// rather than letting vitest buffer/suppress it on a passing run.
		disableConsoleIntercept: true,
	},
});
