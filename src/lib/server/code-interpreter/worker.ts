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
import { createHash } from 'node:crypto';
import { loadPyodide, type PyodideInterface } from 'pyodide';
import { assertHostnameRoutable, assertHttpScheme, UrlPolicyError } from '../tools/url-policy-base';

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

// Configured-backend host set, supplied by the pool at init time. The
// worker can't read config.toml itself (it lives outside Vite's
// transform pipeline and has no env layer in the bundled standalone
// build), so the host snapshots the policy and ships it across the
// message channel — same protection, no shared dependency on the
// SvelteKit env runtime.
let forbiddenHosts: ReadonlySet<string> = new Set();

function assertNotForbiddenHost(url: URL): void {
	const host = url.hostname.toLowerCase();
	if (forbiddenHosts.has(host)) {
		throw new UrlPolicyError(
			`Refused: ${host} is a configured backend (an upstream LLM or search endpoint); the model is not allowed to reach it through tool calls.`,
		);
	}
}

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
		assertNotForbiddenHost(current);
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

interface PreFile {
	filename: string;
	bytes: Uint8Array;
	sha256: string;
}

interface PostFile {
	filename: string;
	bytes: Uint8Array;
	sha256: string;
}

interface RunMessage {
	type: 'run';
	callId: number;
	code: string;
	disabledFeatures: string[];
	preFiles: PreFile[];
}

interface InitMessage {
	type: 'init';
	indexURL?: string;
	/** Hostnames whose model-controlled fetches should be refused. Comes
	 *  from `listForbiddenHosts()` on the host side at worker creation. */
	forbiddenHosts?: readonly string[];
}

type HostMessage = RunMessage | InitMessage;

parentPort.on('message', async (msg: HostMessage) => {
	if (!parentPort) return;
	if (msg.type === 'init') {
		try {
			if (msg.forbiddenHosts) {
				forbiddenHosts = new Set(msg.forbiddenHosts.map((h) => h.toLowerCase()));
			}
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

			// Mount the conversation's attached files into the Pyodide VFS
			// under /workspace/ — per-worker manifest lets us skip files
			// that are byte-identical to what's already there (saves a
			// full re-copy of a multi-MB dataset on every turn).
			materializeWorkspace(py, msg.preFiles);
			const preSnapshot = snapshotWorkspace(py);

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
			// Auto-load any Pyodide packages the code imports (numpy,
			// pandas, matplotlib, scipy, sympy, scikit-learn, ...). Reads
			// from the local node_modules/pyodide/ package store — no
			// network needed for the standard scientific stack. Per
			// Pyodide's docs this is the idiomatic way to surface
			// "common imports just work" semantics inside a single
			// interpreter session.
			await py.loadPackagesFromImports(msg.code);

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

			// Diff /workspace/ against the pre-call snapshot; new or
			// modified files come back to the host to be persisted as
			// conversation media.
			const newFiles = diffWorkspace(py, preSnapshot);

			parentPort.postMessage({
				type: 'result',
				callId: msg.callId,
				stdout,
				stderr,
				result,
				newFiles,
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

// --- VFS file-round-trip helpers ------------------------------------------

const WORKSPACE = '/workspace';
const materializedManifest = new Map<string, string>();

function materializeWorkspace(py: PyodideInterface, preFiles: PreFile[]): void {
	const FS = (py as unknown as { FS: PyodideFS }).FS;
	try {
		FS.mkdir(WORKSPACE);
	} catch {
		// Already exists — fine.
	}
	// Set cwd to /workspace so relative paths Just Work for the model
	// (`pd.read_csv('sales.csv')` etc.). Persistent across calls in the
	// same interpreter. Idempotent.
	try {
		FS.chdir(WORKSPACE);
	} catch {
		// chdir on an already-current dir is a no-op; if it ever does
		// fail we can fall back to the absolute path — not catastrophic.
	}
	const wanted = new Set(preFiles.map((f) => f.filename));

	// Drop materialized files the host no longer says are attached.
	for (const filename of Array.from(materializedManifest.keys())) {
		if (wanted.has(filename)) continue;
		try {
			FS.unlink(`${WORKSPACE}/${filename}`);
		} catch {
			// Best-effort cleanup; missing file is OK.
		}
		materializedManifest.delete(filename);
	}

	for (const f of preFiles) {
		const cached = materializedManifest.get(f.filename);
		if (cached === f.sha256) continue; // unchanged
		try {
			FS.writeFile(`${WORKSPACE}/${f.filename}`, f.bytes);
			materializedManifest.set(f.filename, f.sha256);
		} catch (err) {
			// One bad file shouldn't poison the whole run — log to stderr
			// so the model can see it via captured stderr.
			console.warn(`[code-interpreter] failed to materialize ${f.filename}:`, err);
		}
	}
}

function snapshotWorkspace(py: PyodideInterface): Map<string, string> {
	const snap = new Map<string, string>();
	const FS = (py as unknown as { FS: PyodideFS }).FS;
	try {
		const entries = FS.readdir(WORKSPACE);
		for (const name of entries) {
			if (name === '.' || name === '..') continue;
			// Try readFile directly — succeeds for regular files, throws
			// for directories / specials. Avoids relying on emscripten's
			// stat.mode bits matching Linux S_IFREG semantics exactly.
			try {
				const bytes = FS.readFile(`${WORKSPACE}/${name}`);
				snap.set(name, sha256Hex(bytes));
			} catch {
				// Directory or unreadable — skip.
			}
		}
	} catch {
		// Directory missing → empty snapshot.
	}
	return snap;
}

function diffWorkspace(py: PyodideInterface, preSnapshot: Map<string, string>): PostFile[] {
	const FS = (py as unknown as { FS: PyodideFS }).FS;
	const out: PostFile[] = [];
	try {
		const entries = FS.readdir(WORKSPACE);
		for (const name of entries) {
			if (name === '.' || name === '..') continue;
			try {
				const bytes = FS.readFile(`${WORKSPACE}/${name}`);
				const sha = sha256Hex(bytes);
				if (preSnapshot.get(name) === sha) continue; // unchanged
				out.push({ filename: name, bytes, sha256: sha });
				materializedManifest.set(name, sha);
			} catch {
				// Directory or unreadable — skip.
			}
		}
	} catch {
		// Empty workspace.
	}
	return out;
}

// Pyodide's FS surface is loosely typed in the public package; cherry-pick
// the bits we need so call sites stay type-checked even though the
// underlying object is `any`.
interface PyodideFS {
	mkdir(path: string): void;
	unlink(path: string): void;
	readdir(path: string): string[];
	readFile(path: string): Uint8Array;
	writeFile(path: string, data: Uint8Array): void;
	chdir(path: string): void;
}

function sha256Hex(bytes: Uint8Array): string {
	const h = createHash('sha256');
	h.update(bytes);
	return h.digest('hex');
}
