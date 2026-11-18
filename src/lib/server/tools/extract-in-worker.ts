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
const EXTRACT_HEAP_MB = 256;

/**
 * Workers alive at once. A turn's tool calls run in parallel, so a model fed
 * a page of links could otherwise start one worker per call, each entitled to
 * EXTRACT_HEAP_MB — enough together to reach a container's memory limit.
 * Calls past this wait for a slot inside their own budget.
 */
const MAX_EXTRACT_WORKERS = 3;

export const EXTRACT_TIMEOUT_MESSAGE = 'The page took too long to process.';

let budgetMs = EXTRACT_BUDGET_MS;
let running = 0;
/** Calls waiting for a slot, oldest first; each starts its worker when called. */
const waiting: Array<() => void> = [];

/** Test-only: shorten the budget (no argument restores the default). */
export function setExtractBudgetForTests(ms?: number): void {
	budgetMs = ms ?? EXTRACT_BUDGET_MS;
}

/** Test-only: workers currently running. */
export function runningExtractWorkersForTests(): number {
	return running;
}

function releaseSlot(): void {
	const next = waiting.shift();
	if (next) next();
	else running--;
}

/**
 * Extract `req.html` in a worker. Rejects with EXTRACT_TIMEOUT_MESSAGE when
 * the budget runs out or `signal` aborts first — whether the call was still
 * waiting for a worker slot or its worker was running, which is then
 * terminated.
 */
export function extractInWorker(req: ExtractRequest, signal: AbortSignal): Promise<ExtractedPage> {
	if (signal.aborted) return Promise.reject(new Error(EXTRACT_TIMEOUT_MESSAGE));
	return new Promise((resolve, reject) => {
		let settled = false;
		let worker: Worker | undefined;
		let queued: (() => void) | undefined;
		const settle = (done: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal.removeEventListener('abort', tooSlow);
			if (queued) {
				waiting.splice(waiting.indexOf(queued), 1);
			} else {
				void worker?.terminate();
				releaseSlot();
			}
			done();
		};
		const tooSlow = () => settle(() => reject(new Error(EXTRACT_TIMEOUT_MESSAGE)));
		const timer = setTimeout(tooSlow, budgetMs);
		signal.addEventListener('abort', tooSlow, { once: true });

		const start = () => {
			queued = undefined;
			try {
				worker = new Worker(workerUrl, {
					workerData: req,
					resourceLimits: { maxOldGenerationSizeMb: EXTRACT_HEAP_MB },
				});
			} catch (e) {
				settle(() => reject(new Error(`Could not process the page: ${(e as Error).message}`)));
				return;
			}
			worker.once('message', (page: ExtractedPage) => settle(() => resolve(page)));
			worker.once('error', (e: Error) =>
				settle(() => reject(new Error(`Could not process the page: ${e.message}`))),
			);
			worker.once('exit', (code) =>
				settle(() => reject(new Error(`Could not process the page (worker exited ${code}).`))),
			);
		};

		if (running < MAX_EXTRACT_WORKERS) {
			running++;
			start();
		} else {
			queued = start;
			waiting.push(start);
		}
	});
}
