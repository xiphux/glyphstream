import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	CodeInterpreterConfigError,
	loadCodeInterpreterConfig,
	resetCodeInterpreterConfigForTests,
} from '$lib/server/code-interpreter/config';

let tmpDir: string;
let configPath: string;

function writeConfig(toml: string): void {
	writeFileSync(configPath, toml, 'utf8');
}

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 'code-interp-config-'));
	configPath = join(tmpDir, 'config.toml');
	resetCodeInterpreterConfigForTests();
});

afterEach(() => {
	resetCodeInterpreterConfigForTests();
	rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadCodeInterpreterConfig', () => {
	it('returns defaults when the [code_interpreter] table is absent', () => {
		writeConfig('# empty\n');
		const cfg = loadCodeInterpreterConfig(configPath);
		expect(cfg.enabled).toBe(true);
		expect(cfg.poolMax).toBe(10);
		expect(cfg.idleTimeoutSeconds).toBe(300);
		expect(cfg.callTimeoutSeconds).toBe(30);
		expect(cfg.workerMemoryMb).toBe(512);
		expect(cfg.pyodideIndexUrl).toBe('');
	});

	it('parses every field when present', () => {
		writeConfig(`
[code_interpreter]
enabled = false
pool_max = 4
idle_timeout_seconds = 120
call_timeout_seconds = 60
worker_memory_mb = 1024
pyodide_index_url = "/var/cache/pyodide"
`);
		const cfg = loadCodeInterpreterConfig(configPath);
		expect(cfg).toEqual({
			enabled: false,
			poolMax: 4,
			idleTimeoutSeconds: 120,
			callTimeoutSeconds: 60,
			workerMemoryMb: 1024,
			pyodideIndexUrl: '/var/cache/pyodide',
		});
	});

	it('accepts partial overrides — unspecified fields keep defaults', () => {
		writeConfig(`
[code_interpreter]
call_timeout_seconds = 90
`);
		const cfg = loadCodeInterpreterConfig(configPath);
		expect(cfg.callTimeoutSeconds).toBe(90);
		expect(cfg.workerMemoryMb).toBe(512); // default
		expect(cfg.idleTimeoutSeconds).toBe(300); // default
	});

	it('rejects a non-table [code_interpreter] (e.g. array of tables)', () => {
		writeConfig(`
[[code_interpreter]]
enabled = true
`);
		expect(() => loadCodeInterpreterConfig(configPath)).toThrow(CodeInterpreterConfigError);
	});

	it('rejects non-boolean enabled', () => {
		writeConfig(`
[code_interpreter]
enabled = "yes"
`);
		expect(() => loadCodeInterpreterConfig(configPath)).toThrow(/'enabled' must be a boolean/);
	});

	it('rejects non-integer pool_max', () => {
		writeConfig(`
[code_interpreter]
pool_max = 2.5
`);
		expect(() => loadCodeInterpreterConfig(configPath)).toThrow(/'pool_max' must be an integer/);
	});

	it('rejects pool_max below min', () => {
		writeConfig(`
[code_interpreter]
pool_max = 0
`);
		expect(() => loadCodeInterpreterConfig(configPath)).toThrow(/'pool_max' must be >= 1/);
	});

	it('rejects worker_memory_mb below 64 MB (would put the worker in permanent OOM)', () => {
		// The clamp is a real guard rail: V8's WASM-friendly minimum heap is
		// around 64 MB; smaller and Pyodide can't even finish booting.
		writeConfig(`
[code_interpreter]
worker_memory_mb = 32
`);
		expect(() => loadCodeInterpreterConfig(configPath)).toThrow(/'worker_memory_mb' must be >= 64/);
	});

	it('rejects worker_memory_mb above the upper bound', () => {
		writeConfig(`
[code_interpreter]
worker_memory_mb = 99999
`);
		expect(() => loadCodeInterpreterConfig(configPath)).toThrow(
			/'worker_memory_mb' must be <= 16384/,
		);
	});

	it('rejects call_timeout_seconds below 1', () => {
		writeConfig(`
[code_interpreter]
call_timeout_seconds = 0
`);
		expect(() => loadCodeInterpreterConfig(configPath)).toThrow(
			/'call_timeout_seconds' must be >= 1/,
		);
	});

	it('accepts idle_timeout_seconds = 0 (disable-reaping convention)', () => {
		// idle=0 is the documented "keep the worker warm forever" mode —
		// expected, not a malformed value.
		writeConfig(`
[code_interpreter]
idle_timeout_seconds = 0
`);
		const cfg = loadCodeInterpreterConfig(configPath);
		expect(cfg.idleTimeoutSeconds).toBe(0);
	});

	it('rejects non-string pyodide_index_url', () => {
		writeConfig(`
[code_interpreter]
pyodide_index_url = 42
`);
		expect(() => loadCodeInterpreterConfig(configPath)).toThrow(
			/'pyodide_index_url' must be a string/,
		);
	});

	it('reports file-not-found errors with the absolute path', () => {
		const missingPath = join(tmpDir, 'does-not-exist.toml');
		expect(() => loadCodeInterpreterConfig(missingPath)).toThrow(
			new RegExp(`Could not read config file at .*does-not-exist\\.toml`),
		);
	});

	it('reports parse errors with the absolute path', () => {
		writeConfig(`
[code_interpreter
enabled = true
`);
		expect(() => loadCodeInterpreterConfig(configPath)).toThrow(/Failed to parse TOML/);
	});
});
