/**
 * Run `fetch_url`'s HTML extraction (html-extract.ts) on a worker thread that
 * is terminated when it overruns.
 *
 * Extraction is synchronous and, on hostile markup, superlinear: 64 KB of
 * unclosed `<div>`s keeps linkedom + Readability busy for most of a minute.
 * On the event loop that froze the server for every user, and neither the
 * fetch timeout nor the tool deadline can interrupt synchronous code. A
 * worker can be killed, so a slow page costs one tool error instead.
 */

import { Worker } from 'node:worker_threads';
import type { ExtractRequest, ExtractedPage } from './html-extract';

// NOTE: `./fetch-extract-worker.js` is the esbuild bundle `pnpm build:worker`
// writes next to fetch-extract-worker.ts, which is what `pnpm dev` and vitest
// (tests/unit/_build-fetch-extract-worker.ts) resolve. In a build it is
// scripts/place-worker.mjs that copies it beside whichever chunk this line
// lands in — keep the `new URL('./fetch-extract-worker.js', import.meta.url)`
// form, since that script finds the chunk by it.
const workerUrl = new URL('./fetch-extract-worker.js', import.meta.url);

/**
 * Wall-clock budget for one page, worker startup included. A benign 2 MB page
 * (the body cap) extracts in well under a second, so this leaves ample room
 * for a slow host while ending a pathological page long before the 120 s tool
 * deadline would — no use holding a thread for a page that will never finish.
 */
const EXTRACT_BUDGET_MS = 5_000;

/**
 * Heap ceiling for the worker. linkedom's DOM for a 2 MB page stays far
 * below it; a page built to balloon the tree dies with the worker rather
 * than taking the server's heap with it.
 */
const EXTRACT_HEAP_MB = 512;

export const EXTRACT_TIMEOUT_MESSAGE = 'The page took too long to process.';

let budgetMs = EXTRACT_BUDGET_MS;

/** Test-only: shorten the budget (no argument restores the default). */
export function setExtractBudgetForTests(ms?: number): void {
	budgetMs = ms ?? EXTRACT_BUDGET_MS;
}

/**
 * Extract `req.html` in a fresh worker. Rejects with EXTRACT_TIMEOUT_MESSAGE
 * when the budget runs out or `signal` aborts first, terminating the worker
 * either way.
 */
export function extractInWorker(req: ExtractRequest, signal: AbortSignal): Promise<ExtractedPage> {
	if (signal.aborted) return Promise.reject(new Error(EXTRACT_TIMEOUT_MESSAGE));
	return new Promise((resolve, reject) => {
		const worker = new Worker(workerUrl, {
			workerData: req,
			resourceLimits: { maxOldGenerationSizeMb: EXTRACT_HEAP_MB },
		});
		let settled = false;
		const settle = (done: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal.removeEventListener('abort', tooSlow);
			void worker.terminate();
			done();
		};
		const tooSlow = () => settle(() => reject(new Error(EXTRACT_TIMEOUT_MESSAGE)));
		const timer = setTimeout(tooSlow, budgetMs);
		signal.addEventListener('abort', tooSlow, { once: true });

		worker.once('message', (page: ExtractedPage) => settle(() => resolve(page)));
		worker.once('error', (e: Error) =>
			settle(() => reject(new Error(`Could not process the page: ${e.message}`))),
		);
		worker.once('exit', (code) =>
			settle(() => reject(new Error(`Could not process the page (worker exited ${code}).`))),
		);
	});
}
