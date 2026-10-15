/**
 * Config loader for the server-side Pyodide code interpreter.
 *
 * `[code_interpreter]` is a single optional table in `config.toml`; absent
 * → defaults; malformed → ConfigError, the same error the endpoint and MCP
 * loaders throw, so boot fails loudly the same way their misconfig does. Once
 * loaded, the config is memoized — like every other config in this
 * codebase, it's read once per process and stable for the lifetime.
 *
 * Defaults are tuned for a solo-user self-host: aggressive idle reaping
 * (5 min), a 30 s wall-clock per-call ceiling, 512 MB V8 heap per worker,
 * and a 10-slot pool. Operators can override any field; the validator
 * clamps each to sane bounds rather than blindly trusting input (e.g.
 * `worker_memory_mb >= 64` so a typo can't put the worker in a
 * permanently-OOM state).
 *
 * Stage 3 ships the config; stage 4 wires `run_python` to consume it.
 */

import {
	ConfigError,
	readConfigToml,
	requireBoolean,
	requireNumber,
	requireString,
} from '../config/toml';
import { configPath } from '../env';
import { memoizeConfig } from '../util/config-cache';

export interface LoadedCodeInterpreterConfig {
	/** Master switch. When false, `run_python` advertises as unavailable. */
	enabled: boolean;
	/** Hard cap on concurrent live workers; LRU-evict on the (N+1)th. */
	poolMax: number;
	/** Seconds since last use before the idle reaper closes a worker.
	 *  0 disables reaping (workers stay warm for the process lifetime). */
	idleTimeoutSeconds: number;
	/** Wall-clock budget per individual `runPython` call. On overrun the
	 *  worker is terminated and the entry transitions to 'failed'. */
	callTimeoutSeconds: number;
	/** V8 heap cap for each worker process, in megabytes. Sets
	 *  `--max-old-space-size` on the spawned child process. */
	workerMemoryMb: number;
	/** Ceiling on Python's own memory (Pyodide's WebAssembly heap), in
	 *  megabytes. Enforced by V8 (`--wasm-max-mem-pages`), so an allocation
	 *  past it raises MemoryError inside Python rather than killing the
	 *  process. `workerMemoryMb` does not bound this heap. */
	pythonMemoryMb: number;
	/** Optional override for Pyodide's `indexURL`. Empty string = resolve
	 *  from the installed `pyodide` package's `node_modules` location.
	 *  Operators only need this if they're vendoring a custom Pyodide
	 *  build outside `node_modules`. */
	pyodideIndexUrl: string;
}

const DEFAULTS: LoadedCodeInterpreterConfig = {
	enabled: true,
	poolMax: 10,
	idleTimeoutSeconds: 300,
	callTimeoutSeconds: 30,
	workerMemoryMb: 512,
	// Above what a warm interpreter with the scientific stack loaded reaches
	// (~500 MB), so ordinary work never meets it.
	pythonMemoryMb: 1024,
	pyodideIndexUrl: '',
};

/**
 * Read + parse + validate `[code_interpreter]` from `config.toml`. Throws
 * `ConfigError` on any structural problem; absence of the
 * table is fine (returns defaults). The path argument exists for tests.
 */
export function loadCodeInterpreterConfig(path = configPath()): LoadedCodeInterpreterConfig {
	const { parsed, absolutePath } = readConfigToml(path);
	const raw = parsed.code_interpreter;
	if (raw === undefined) return { ...DEFAULTS };

	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		throw new ConfigError(`'[code_interpreter]' in ${absolutePath} must be a TOML table`);
	}
	const block = raw as Record<string, unknown>;
	const at = `[code_interpreter] in ${absolutePath}`;

	const enabled =
		block.enabled === undefined ? DEFAULTS.enabled : requireBoolean(block.enabled, 'enabled', at);

	const poolMax =
		block.pool_max === undefined
			? DEFAULTS.poolMax
			: requireNumber(block.pool_max, 'pool_max', at, { min: 1, max: 100, integer: true });

	const idleTimeoutSeconds =
		block.idle_timeout_seconds === undefined
			? DEFAULTS.idleTimeoutSeconds
			: requireNumber(block.idle_timeout_seconds, 'idle_timeout_seconds', at, { min: 0 });

	const callTimeoutSeconds =
		block.call_timeout_seconds === undefined
			? DEFAULTS.callTimeoutSeconds
			: requireNumber(block.call_timeout_seconds, 'call_timeout_seconds', at, {
					min: 1,
					max: 600,
				});

	const workerMemoryMb =
		block.worker_memory_mb === undefined
			? DEFAULTS.workerMemoryMb
			: requireNumber(block.worker_memory_mb, 'worker_memory_mb', at, {
					min: 64,
					max: 16384,
					integer: true,
				});

	const pythonMemoryMb =
		block.python_memory_mb === undefined
			? DEFAULTS.pythonMemoryMb
			: requireNumber(block.python_memory_mb, 'python_memory_mb', at, {
					min: 128,
					max: 65536,
					integer: true,
				});

	const pyodideIndexUrl =
		block.pyodide_index_url === undefined
			? DEFAULTS.pyodideIndexUrl
			: requireString(block.pyodide_index_url, 'pyodide_index_url', at, { allowEmpty: true });

	return {
		enabled,
		poolMax,
		idleTimeoutSeconds,
		callTimeoutSeconds,
		workerMemoryMb,
		pythonMemoryMb,
		pyodideIndexUrl,
	};
}

/** Process-wide accessor. Lazily parses + memoizes on first call. */
export const getCodeInterpreterConfig = memoizeConfig(() => loadCodeInterpreterConfig());

/** Master toggle — surfaced as the `run_python` tool's `isAvailable`
 *  predicate in stage 4. Operators can disable the feature without
 *  removing the registration. */
export function isCodeInterpreterEnabled(): boolean {
	return getCodeInterpreterConfig().enabled;
}
