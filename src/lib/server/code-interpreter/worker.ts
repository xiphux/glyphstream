/**
 * Pyodide code-interpreter worker.
 *
 * Runs inside a `worker_threads.Worker` spawned by the pool. Loads Pyodide
 * lazily on first `run` message, installs a `globalThis.fetch` shim that
 * routes every outbound HTTP call through the shared URL-policy module,
 * then executes user code against a persistent Python interpreter.
 *
 * Message protocol:
 *  - host → worker
 *      { type: 'init', indexURL?: string }
 *      { type: 'run', callId: number, code: string, disabledFeatures: string[] }
 *  - worker → host
 *      { type: 'ready' }
 *      { type: 'result', callId: number, stdout: string, stderr: string,
 *        result: unknown }
 *      { type: 'error', callId: number, message: string }
 *
 * Stage 3 ships the shim, the message loop, and the Pyodide bootstrap.
 * The shim already consults stage 2's `assertHttpScheme` /
 * `assertNotConfiguredBackend` / `assertHostnameRoutable`; the `web`
 * feature-category check (`disabledFeatures.has('web')`) is honored
 * here too, ready for stage 4 to populate `disabledFeatures` from the
 * conversation. With no caller wired in yet, any incoming `run` is a
 * test fixture or stage-4 plumbing — the network shim still applies.
 *
 * Why a global `fetch` override: Pyodide's `pyfetch` (and therefore
 * `urllib`, `requests`, `micropip`) resolves to whatever `fetch` exists
 * on the global at call time. Replacing it once before `loadPyodide`
 * is enough to gate every Python network call through one chokepoint.
 */

import { parentPort } from 'node:worker_threads';
import { loadPyodide, type PyodideInterface } from 'pyodide';
import {
	assertHostnameRoutable,
	assertHttpScheme,
	assertNotConfiguredBackend,
	UrlPolicyError,
} from '../tools/url-policy';

// `parentPort` is non-null inside a worker_threads worker. If it's null
// we've been imported by the main thread (test, dev tooling) — bail
// politely rather than installing global shims into the host process.
if (!parentPort) {
	throw new Error('code-interpreter/worker.ts must be loaded inside a worker_threads worker');
}

type DisabledFeatures = ReadonlySet<string>;
const NETWORK_FEATURE = 'web';

interface CurrentCall {
	disabledFeatures: DisabledFeatures;
}

// Per-call closure. The fetch shim reads this; the run handler stamps
// it before executing user code and clears it after. Network calls
// outside an authorized run (e.g. background Pyodide internals fetching
// stdlib chunks AFTER the initial load) are refused.
let currentCall: CurrentCall | null = null;

const realFetch = globalThis.fetch.bind(globalThis);
const MAX_REDIRECTS = 3;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	if (!currentCall) {
		throw new UrlPolicyError('Refused: network call outside an authorized run_python invocation.');
	}

	let target: URL;
	if (input instanceof URL) {
		target = new URL(input.href);
	} else if (typeof input === 'string') {
		target = new URL(input);
	} else {
		target = new URL(input.url);
	}

	return followWithRevalidation(target, init, currentCall);
}) as typeof fetch;

async function followWithRevalidation(
	initial: URL,
	init: RequestInit | undefined,
	call: CurrentCall,
): Promise<Response> {
	let current = initial;
	let lastBodyInit = init?.body;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		assertHttpScheme(current);
		assertNotConfiguredBackend(current);
		if (call.disabledFeatures.has(NETWORK_FEATURE)) {
			throw new UrlPolicyError(
				'Refused: web access is disabled for this conversation; Python network calls (including pyfetch / micropip) are blocked.',
			);
		}
		await assertHostnameRoutable(current.hostname);

		// `redirect: 'manual'` so the policy re-runs on every hop. Body is
		// only forwarded on the first hop (a redirect that wants a body
		// would normally use 307/308 anyway; we don't replay it because
		// preserving body semantics across hops is its own can of worms).
		const res = await realFetch(current, {
			...init,
			redirect: 'manual',
			body: hop === 0 ? lastBodyInit : undefined,
		});

		if (res.status >= 300 && res.status < 400) {
			const loc = res.headers.get('location');
			await res.body?.cancel().catch(() => {});
			if (!loc) {
				throw new UrlPolicyError(
					`HTTP ${res.status} redirect from ${current.hostname} without a Location header.`,
				);
			}
			if (hop >= MAX_REDIRECTS) {
				throw new UrlPolicyError(`Refused: exceeded ${MAX_REDIRECTS} redirects.`);
			}
			try {
				current = new URL(loc, current);
			} catch {
				throw new UrlPolicyError(`Redirect Location "${loc}" is not a valid URL.`);
			}
			continue;
		}

		return res;
	}
	throw new UrlPolicyError(`Refused: exceeded ${MAX_REDIRECTS} redirects.`);
}

// --- Pyodide bootstrap + message loop -------------------------------------

let pyodide: PyodideInterface | null = null;
let pyodideInitPromise: Promise<PyodideInterface> | null = null;

async function getPyodide(indexURL?: string): Promise<PyodideInterface> {
	if (pyodide) return pyodide;
	if (pyodideInitPromise) return pyodideInitPromise;
	pyodideInitPromise = (async () => {
		// loadPyodide accepts an explicit indexURL; absent, it discovers
		// the package directory next to its own bundled JS, which works
		// for the `pyodide` npm package's normal install layout.
		const inst = await loadPyodide(indexURL ? { indexURL } : undefined);
		pyodide = inst;
		return inst;
	})();
	return pyodideInitPromise;
}

interface RunMessage {
	type: 'run';
	callId: number;
	code: string;
	disabledFeatures: string[];
}

interface InitMessage {
	type: 'init';
	indexURL?: string;
}

type HostMessage = RunMessage | InitMessage;

parentPort.on('message', async (msg: HostMessage) => {
	if (!parentPort) return;
	if (msg.type === 'init') {
		try {
			await getPyodide(msg.indexURL);
			parentPort.postMessage({ type: 'ready' });
		} catch (err) {
			parentPort.postMessage({
				type: 'error',
				callId: -1,
				message: err instanceof Error ? err.message : String(err),
			});
		}
		return;
	}

	if (msg.type === 'run') {
		try {
			const py = await getPyodide();
			currentCall = { disabledFeatures: new Set(msg.disabledFeatures) };
			let stdout = '';
			let stderr = '';
			py.setStdout({
				batched: (s: string) => {
					stdout += s;
				},
			});
			py.setStderr({
				batched: (s: string) => {
					stderr += s;
				},
			});
			let result: unknown = null;
			try {
				const raw = await py.runPythonAsync(msg.code);
				// pyodide's PyProxy needs explicit conversion for the host;
				// `toJs` recursively maps to native JS. Primitives pass
				// through unchanged.
				if (raw && typeof raw === 'object' && 'toJs' in raw) {
					result = (raw as { toJs: () => unknown }).toJs();
					// PyProxy refs leak by design — clean up after the conversion.
					if ('destroy' in raw) {
						(raw as { destroy: () => void }).destroy();
					}
				} else {
					result = raw;
				}
			} finally {
				currentCall = null;
			}
			parentPort.postMessage({
				type: 'result',
				callId: msg.callId,
				stdout,
				stderr,
				result,
			});
		} catch (err) {
			parentPort.postMessage({
				type: 'error',
				callId: msg.callId,
				message: err instanceof Error ? err.message : String(err),
			});
		}
	}
});
