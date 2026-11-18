/**
 * Vitest globalSetup for the unit project: bundle fetch_url's extraction
 * worker exactly as `pnpm build:worker` does, to the path
 * extract-in-worker.ts resolves, so every test that fetches an HTML page runs
 * the real worker — CI's `pnpm test` runs no build step first.
 */
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

export default async function setup(): Promise<void> {
	await build({
		entryPoints: [
			fileURLToPath(new URL('../../src/lib/server/tools/fetch-extract-worker.ts', import.meta.url)),
		],
		bundle: true,
		platform: 'node',
		target: 'node26',
		format: 'esm',
		outfile: fileURLToPath(
			new URL('../../src/lib/server/tools/fetch-extract-worker.js', import.meta.url),
		),
		logLevel: 'silent',
	});
}
