/**
 * Worker-thread entry for `fetch_url`'s HTML extraction: reads an
 * ExtractRequest from `workerData`, posts back the ExtractedPage, and exits.
 *
 * esbuild bundles this (with linkedom and Readability, which the image's
 * production install omits) to `fetch-extract-worker.js` beside it — see
 * `build:worker` in package.json and scripts/place-worker.mjs. One worker per
 * page, so a page that takes too long is dealt with by terminating it.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { extractPage, type ExtractRequest } from './html-extract';

if (!parentPort) throw new Error('fetch-extract-worker must run as a worker thread');
parentPort.postMessage(extractPage(workerData as ExtractRequest));
