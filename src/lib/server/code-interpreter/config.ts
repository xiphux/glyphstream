/**
 * Config loader for the server-side Pyodide code interpreter.
 *
 * `[code_interpreter]` is a single optional table in `config.toml`; absent
 * → defaults; malformed → CodeInterpreterConfigError (extends ConfigError
 * so boot fails loudly the same way endpoint / MCP misconfig does). Once
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

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { configPath } from '../env';

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
	/** V8 old-space cap for each worker, in megabytes. Sets
	 *  `resourceLimits.maxOldGenerationSizeMb` on the spawned Worker. */
	workerMemoryMb: number;
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
	pyodideIndexUrl: '',
};

export class CodeInterpreterConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CodeInterpreterConfigError';
	}
}

function readAndParse(path: string): { parsed: Record<string, unknown>; absolutePath: string } {
	const absolutePath = resolve(path);
	let raw: string;
	try {
		raw = readFileSync(absolutePath, 'utf8');
	} catch (e) {
		const cause = e instanceof Error ? e.message : String(e);
		throw new CodeInterpreterConfigError(`Could not read config file at ${absolutePath}: ${cause}`);
	}

	let parsed: unknown;
	try {
		parsed = parseToml(raw);
	} catch (e) {
		const cause = e instanceof Error ? e.message : String(e);
		throw new CodeInterpreterConfigError(`Failed to parse TOML at ${absolutePath}: ${cause}`);
	}

	if (typeof parsed !== 'object' || parsed === null) {
		throw new CodeInterpreterConfigError(`Top-level of ${absolutePath} must be a TOML table`);
	}

	return { parsed: parsed as Record<string, unknown>, absolutePath };
}

/**
 * Read + parse + validate `[code_interpreter]` from `config.toml`. Throws
 * `CodeInterpreterConfigError` on any structural problem; absence of the
 * table is fine (returns defaults). The path argument exists for tests.
 */
export function loadCodeInterpreterConfig(path = configPath()): LoadedCodeInterpreterConfig {
	const { parsed, absolutePath } = readAndParse(path);
	const raw = parsed.code_interpreter;
	if (raw === undefined) return { ...DEFAULTS };

	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		throw new CodeInterpreterConfigError(
			`'[code_interpreter]' in ${absolutePath} must be a TOML table`,
		);
	}
	const block = raw as Record<string, unknown>;
	const at = `[code_interpreter] in ${absolutePath}`;

	const enabled =
		block.enabled === undefined ? DEFAULTS.enabled : requireBool(block.enabled, 'enabled', at);

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
		pyodideIndexUrl,
	};
}

let cached: LoadedCodeInterpreterConfig | null = null;

/** Process-wide accessor. Lazily parses + memoizes on first call. */
export function getCodeInterpreterConfig(): LoadedCodeInterpreterConfig {
	if (!cached) cached = loadCodeInterpreterConfig();
	return cached;
}

/** Master toggle — surfaced as the `run_python` tool's `isAvailable`
 *  predicate in stage 4. Operators can disable the feature without
 *  removing the registration. */
export function isCodeInterpreterEnabled(): boolean {
	return getCodeInterpreterConfig().enabled;
}

/** Test-only: drop the memo so the next call re-parses (or picks up a
 *  test-supplied path). */
export function resetCodeInterpreterConfigForTests(): void {
	cached = null;
}

// --- validators -----------------------------------------------------------

function requireBool(v: unknown, field: string, at: string): boolean {
	if (typeof v !== 'boolean') {
		throw new CodeInterpreterConfigError(`${at}: '${field}' must be a boolean`);
	}
	return v;
}

function requireString(
	v: unknown,
	field: string,
	at: string,
	opts: { allowEmpty?: boolean } = {},
): string {
	if (typeof v !== 'string') {
		throw new CodeInterpreterConfigError(`${at}: '${field}' must be a string`);
	}
	if (!opts.allowEmpty && v.length === 0) {
		throw new CodeInterpreterConfigError(`${at}: '${field}' must be a non-empty string`);
	}
	return v;
}

function requireNumber(
	v: unknown,
	field: string,
	at: string,
	opts: { min?: number; max?: number; integer?: boolean } = {},
): number {
	if (typeof v !== 'number' || !Number.isFinite(v)) {
		throw new CodeInterpreterConfigError(`${at}: '${field}' must be a number`);
	}
	if (opts.integer && !Number.isInteger(v)) {
		throw new CodeInterpreterConfigError(`${at}: '${field}' must be an integer`);
	}
	if (opts.min !== undefined && v < opts.min) {
		throw new CodeInterpreterConfigError(`${at}: '${field}' must be >= ${opts.min}`);
	}
	if (opts.max !== undefined && v > opts.max) {
		throw new CodeInterpreterConfigError(`${at}: '${field}' must be <= ${opts.max}`);
	}
	return v;
}
