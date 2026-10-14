/**
 * Pyodide code-interpreter worker.
 *
 * Runs as a CHILD PROCESS spawned by the pool (spawn.ts) under Node's
 * permission model: no environment, fs read limited to this bundle and the
 * Pyodide package, no fs write, no network, no child processes, no signals. Loads
 * Pyodide on `init`, then executes model-written code against one persistent
 * interpreter per conversation.
 *
 * Message protocol (IPC, structured-clone serialization):
 *  - host → worker
 *      { type: 'init', indexURL?: string, pyodideModuleUrl: string }
 *      { type: 'run', callId, code, preFiles }
 *      { type: 'fetch-result', fetchId, response } | { type: 'fetch-result', fetchId, error }
 *  - worker → host
 *      { type: 'ready' }
 *      { type: 'result', callId, stdout, stderr, result, newFiles }
 *      { type: 'error', callId, message }
 *      { type: 'fetch', fetchId, request }
 *      { type: 'cache-package', path, bytes }
 *
 * Networking: Pyodide's `pyfetch` (and so `urllib`, `requests`, `micropip`)
 * resolves to whatever `fetch` exists on the global at call time. That is
 * replaced below with a shim that sends the request to the host, which owns
 * the whole URL policy (net-proxy.ts). The shim is a convenience, not the
 * boundary — the process has no network permission, so anything that slips
 * past it (Pyodide's socket transport, `getBuiltinModule('net')`) fails.
 */

import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { PyodideInterface } from 'pyodide';

if (typeof process.send !== 'function') {
	throw new Error('code-interpreter/worker must be spawned as a child process with an IPC channel');
}
const sendToHost = (msg: unknown): void => {
	process.send?.(msg);
};
// The host died or dropped us: don't linger as an orphan interpreter.
process.on('disconnect', () => process.exit(0));

// Pyodide's NODEFS static init reads `process.binding("constants").fs`, and
// the permission model refuses `process.binding` outright. Answer that one
// lookup from the public `fs.constants`; everything else stays refused.
{
	const proc = process as unknown as { binding: (name: string) => unknown };
	const realBinding = proc.binding.bind(process);
	proc.binding = (name: string) => (name === 'constants' ? { fs: fsConstants } : realBinding(name));
}

// The permission model has no signal permission: `process.kill` would let
// model-written code (via `js.process`) signal the host by `process.ppid`, or
// any process the server's user owns. Nothing here needs to send a signal, so
// replace both entry points and keep no reference to the originals.
{
	const refuse = (): never => {
		throw new Error('Sending signals is not permitted in the code interpreter');
	};
	const proc = process as unknown as { kill: unknown; _kill?: unknown };
	proc.kill = refuse;
	if ('_kill' in proc) proc._kill = refuse;
}

/**
 * Pyodide caches a wheel it downloaded from its CDN by writing it into its
 * own package directory, and treats a failed write as a failed import. This
 * process has no write permission, so a denied write under that directory is
 * handed to the host, which caches the wheel only if it matches Pyodide's
 * lockfile (package-cache.ts), and the import carries on with the bytes it
 * already has. Every other write keeps failing as before.
 */
function routePackageCacheWritesToHost(packageDir: string): void {
	const fsp = process.getBuiltinModule('node:fs/promises');
	const realWriteFile = fsp.writeFile;
	const prefix = packageDir.endsWith('/') ? packageDir : `${packageDir}/`;
	(fsp as { writeFile: typeof realWriteFile }).writeFile = async (file, data, options) => {
		try {
			await realWriteFile(file, data, options);
		} catch (err) {
			const denied = (err as { code?: unknown }).code === 'ERR_ACCESS_DENIED';
			if (!denied || typeof file !== 'string' || !file.startsWith(prefix)) throw err;
			if (!(data instanceof Uint8Array)) throw err;
			sendToHost({ type: 'cache-package', path: file, bytes: data });
		}
	};
	// Pyodide imports `node:fs/promises` as an ES module; propagate the
	// replacement into that namespace.
	syncBuiltinESMExports();
}

interface CurrentCall {
	callId: number;
}

// Set while a `run` is executing. The fetch shim refuses outside a run, so
// background Pyodide internals can't reach the host proxy between calls.
let currentCall: CurrentCall | null = null;

interface FetchResponseWire {
	status: number;
	statusText: string;
	headers: Array<[string, string]>;
	body: Uint8Array<ArrayBuffer>;
	url: string;
}
type FetchResultMessage =
	| { type: 'fetch-result'; fetchId: number; response: FetchResponseWire }
	| { type: 'fetch-result'; fetchId: number; error: string };

let nextFetchId = 1;
const pendingFetches = new Map<number, (msg: FetchResultMessage) => void>();
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
	if (!currentCall) {
		throw new Error('Refused: network call outside an authorized run_python invocation.');
	}
	const request = new Request(input, init);
	const body = request.body ? new Uint8Array(await request.arrayBuffer()) : null;
	const headers: Array<[string, string]> = [];
	request.headers.forEach((value, key) => headers.push([key, value]));

	const fetchId = nextFetchId++;
	const reply = new Promise<FetchResultMessage>((resolve) => pendingFetches.set(fetchId, resolve));
	sendToHost({
		type: 'fetch',
		fetchId,
		request: { url: request.url, method: request.method, headers, body },
	});
	const msg = await reply;
	if ('error' in msg) throw new Error(msg.error);

	const r = msg.response;
	const response = new Response(NULL_BODY_STATUSES.has(r.status) ? null : r.body, {
		status: r.status,
		statusText: r.statusText,
		headers: r.headers,
	});
	Object.defineProperty(response, 'url', { value: r.url });
	return response;
};

// --- Pyodide bootstrap + message loop -------------------------------------

let pyodide: PyodideInterface | null = null;
let pyodideInitPromise: Promise<PyodideInterface> | null = null;

async function getPyodide(moduleUrl?: string, indexURL?: string): Promise<PyodideInterface> {
	if (pyodide) return pyodide;
	if (pyodideInitPromise) return pyodideInitPromise;
	if (!moduleUrl) throw new Error('code-interpreter worker: init did not supply pyodideModuleUrl');
	pyodideInitPromise = (async () => {
		routePackageCacheWritesToHost(dirname(fileURLToPath(moduleUrl)));
		const { loadPyodide } = (await import(moduleUrl)) as typeof import('pyodide');
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
	preFiles: PreFile[];
}

interface InitMessage {
	type: 'init';
	indexURL?: string;
	pyodideModuleUrl?: string;
}

type HostMessage = RunMessage | InitMessage | FetchResultMessage;

process.on('message', (raw: unknown) => void handleHostMessage(raw as HostMessage));

async function handleHostMessage(msg: HostMessage): Promise<void> {
	if (msg.type === 'fetch-result') {
		const resolve = pendingFetches.get(msg.fetchId);
		pendingFetches.delete(msg.fetchId);
		resolve?.(msg);
		return;
	}
	if (msg.type === 'init') {
		try {
			await getPyodide(msg.pyodideModuleUrl, msg.indexURL);
			sendToHost({ type: 'ready' });
		} catch (err) {
			sendToHost({
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
			currentCall = { callId: msg.callId };

			// Mount the conversation's attached files into the Pyodide VFS
			// under /workspace/ — per-worker manifest lets us skip files
			// that are byte-identical to what's already there (saves a
			// full re-copy of a multi-MB dataset on every turn).
			materializeWorkspace(py, msg.preFiles);
			const preSnapshot = snapshotWorkspace(py);

			// Bounded: a print loop otherwise grows these strings until the
			// process runs out of memory, all for output nobody can read. Past
			// the cap, the rest is counted and dropped.
			const out = cappedCollector();
			const err = cappedCollector();
			py.setStdout({ batched: out.push });
			py.setStderr({ batched: err.push });
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
				const raw = (await py.runPythonAsync(msg.code)) as unknown;
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

			sendToHost({
				type: 'result',
				callId: msg.callId,
				stdout: out.text(),
				stderr: err.text(),
				result,
				newFiles,
			});
		} catch (err) {
			// A failure before the run itself (a package that wouldn't load, a
			// bad pre-file) skips the inner `finally`; the call is over either way.
			currentCall = null;
			sendToHost({
				type: 'error',
				callId: msg.callId,
				message: err instanceof Error ? err.message : String(err),
			});
		}
	}
}

// --- VFS file-round-trip helpers ------------------------------------------

const WORKSPACE = '/workspace';
const materializedManifest = new Map<string, string>();

/**
 * Per-file and aggregate caps on what comes back out of /workspace/.
 *
 * The worker has a memory ceiling already, but generated files are
 * shipped to the host via `postMessage` and then written through the
 * MediaStore — a 500 MB file would round-trip across the message channel
 * before anyone could intervene. These caps bound the worst case to
 * roughly the user-upload cap (25 MB per file, 50 MB total). Code that
 * blows past them gets its file silently dropped from the result and a
 * warning in the server logs; the model sees the file isn't in `files:`
 * and can chunk on the next turn.
 */
const MAX_GENERATED_FILE_BYTES = 25 * 1024 * 1024;
const MAX_GENERATED_TOTAL_BYTES = 50 * 1024 * 1024;

/**
 * Reject filenames that would let a model escape /workspace/. The shipped
 * surface (pre-files from the host AND files Pyodide's `readdir` returns)
 * should never contain `/`, `..`, or NUL — but a sloppy upload row's
 * `originalFilename` can carry `../etc/passwd` style strings, and a
 * future Pyodide VFS quirk could surface a weird name. Refuse anything
 * non-trivial so a single broken file can't corrupt this worker's
 * Pyodide stdlib (sandboxed inside WASM — no host filesystem reach —
 * but corruption forces an LRU evict + cold restart).
 */
function isSafeWorkspaceFilename(name: string): boolean {
	if (!name) return false;
	if (name === '.' || name === '..') return false;
	if (name.includes('/') || name.includes('\\') || name.includes('\0')) return false;
	return true;
}

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
	const safe = preFiles.filter((f) => {
		if (isSafeWorkspaceFilename(f.filename)) return true;
		console.warn(`[code-interpreter] refused unsafe pre-file name: ${JSON.stringify(f.filename)}`);
		return false;
	});
	const wanted = new Set(safe.map((f) => f.filename));

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

	for (const f of safe) {
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
	let totalBytes = 0;
	try {
		const entries = FS.readdir(WORKSPACE);
		for (const name of entries) {
			if (name === '.' || name === '..') continue;
			if (!isSafeWorkspaceFilename(name)) continue;
			try {
				const bytes = FS.readFile(`${WORKSPACE}/${name}`);
				if (bytes.byteLength > MAX_GENERATED_FILE_BYTES) {
					console.warn(
						`[code-interpreter] dropped /workspace/${name}: ${bytes.byteLength}B exceeds per-file cap (${MAX_GENERATED_FILE_BYTES}B)`,
					);
					continue;
				}
				const sha = sha256Hex(bytes);
				if (preSnapshot.get(name) === sha) continue; // unchanged
				if (totalBytes + bytes.byteLength > MAX_GENERATED_TOTAL_BYTES) {
					console.warn(
						`[code-interpreter] dropped /workspace/${name}: aggregate diff would exceed ${MAX_GENERATED_TOTAL_BYTES}B`,
					);
					continue;
				}
				totalBytes += bytes.byteLength;
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

/** Most characters of stdout (or stderr) one run keeps. */
const MAX_STREAM_CHARS = 1_000_000;

function cappedCollector(): { push: (s: string) => void; text: () => string } {
	let kept = '';
	let dropped = 0;
	return {
		push: (s: string) => {
			const room = MAX_STREAM_CHARS - kept.length;
			if (room >= s.length) kept += s;
			else {
				kept += s.slice(0, Math.max(0, room));
				dropped += s.length - Math.max(0, room);
			}
		},
		text: () => (dropped ? `${kept}\n[… ${dropped} more characters of output not kept]` : kept),
	};
}
