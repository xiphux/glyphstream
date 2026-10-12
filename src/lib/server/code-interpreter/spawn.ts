/**
 * Start a code-interpreter worker as a child process under Node's permission
 * model.
 *
 * Why a process and not a worker thread: Pyodide's `js` module is the host
 * global scope, and in a `worker_threads` worker that still carries Node's
 * `process` — its environment (every secret the server was started with),
 * `getBuiltinModule('fs')`, `child_process`, and Pyodide's own Node socket
 * transport. WebAssembly isolates Python objects, not that bridge, and no
 * amount of trimming the globals closes it from inside the same process
 * (`Function` and `import()` reach everything back). A separate process with
 * permissions enforced by Node itself does:
 *
 *   - `env: {}` — the child sees no environment variables at all;
 *   - `--permission` with fs READ granted only for the worker bundle and the
 *     Pyodide package — not the database, media store, config, `.env`, or
 *     `/proc/self/environ`; no fs write grant at all;
 *   - no `--allow-child-process`, `--allow-worker`, `--allow-addons`,
 *     `--allow-wasi` — none of those are available;
 *   - no `--allow-net` — the child cannot open a socket. Its `fetch` is
 *     proxied to the host, which applies the URL policy (net-proxy.ts).
 *
 * The pool only needs the small `ManagedWorker` surface, so a test can swap in
 * a fake via `setWorkerFactoryForTests`.
 */

import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { constants as osConstants } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Minimum surface area the pool requires from a worker handle. The real
 * implementation wraps a `ChildProcess`; tests pass a stub with the same
 * shape.
 */
export interface ManagedWorker {
	postMessage(value: unknown): void;
	on(event: 'message', listener: (value: unknown) => void): void;
	on(event: 'error', listener: (err: Error) => void): void;
	on(event: 'exit', listener: (code: number) => void): void;
	terminate(): Promise<number>;
	/** OS process id, when the worker is a real process. */
	readonly pid?: number;
}

/** Absolute directory of the installed `pyodide` package (symlinks resolved). */
export function pyodidePackageDir(): string {
	const require = createRequire(import.meta.url);
	return dirname(require.resolve('pyodide'));
}

/** `file:` URL of Pyodide's ESM entry, which the worker imports at init.
 *  The worker can't resolve the bare `pyodide` specifier itself: module
 *  resolution would walk directories it has no read grant for. */
export function pyodideModuleUrl(packageDir: string = pyodidePackageDir()): string {
	return pathToFileURL(join(packageDir, 'pyodide.mjs')).href;
}

export interface SpawnInterpreterOptions {
	/** Absolute path of the bundled worker script. */
	workerPath: string;
	/** V8 heap ceiling for the child. Pyodide's WASM heap is bounded
	 *  separately by the pool's RSS watchdog. */
	memoryMb: number;
	/** Pyodide package directory to grant read access to. */
	pyodideDir?: string;
	/** Extra read-only paths, e.g. a local `pyodide_index_url`. */
	extraReadPaths?: readonly string[];
}

export function spawnInterpreterProcess(opts: SpawnInterpreterOptions): ManagedWorker {
	const pyodideDir = opts.pyodideDir ?? pyodidePackageDir();
	const readPaths = [opts.workerPath, pyodideDir, ...(opts.extraReadPaths ?? [])];
	const child = fork(opts.workerPath, [], {
		execArgv: [
			'--permission',
			...readPaths.map((p) => `--allow-fs-read=${p}`),
			`--max-old-space-size=${opts.memoryMb}`,
		],
		env: {},
		serialization: 'advanced',
		stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
	});

	return {
		get pid() {
			return child.pid;
		},
		postMessage(value: unknown) {
			if (!child.connected) return;
			// The callback form reports a closed channel to us instead of as
			// an 'error' event; the 'exit' listener already handles a dead
			// child, so there is nothing more to do here.
			child.send(value as object, () => {});
		},
		on(event: 'message' | 'error' | 'exit', listener: (arg: never) => void) {
			if (event === 'exit') {
				child.on('exit', (code, signal) => {
					const signalNumber = signal ? (osConstants.signals[signal] ?? 0) : 0;
					(listener as (code: number) => void)(code ?? (signal ? 128 + signalNumber : 1));
				});
			} else {
				child.on(event, listener as (arg: unknown) => void);
			}
		},
		terminate(): Promise<number> {
			return new Promise((resolve) => {
				if (child.exitCode !== null || child.signalCode !== null) {
					resolve(child.exitCode ?? 1);
					return;
				}
				child.once('exit', (code) => resolve(code ?? 1));
				child.kill('SIGKILL');
			});
		},
	};
}
