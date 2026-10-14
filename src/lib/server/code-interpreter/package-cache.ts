/**
 * Caches Pyodide package wheels on the interpreter's behalf.
 *
 * In Node, Pyodide loads a package from its own install directory and, on a
 * miss, downloads it from the Pyodide CDN and writes the wheel back there so
 * the next interpreter starts warm. The interpreter process has no fs write
 * permission (spawn.ts), so that write is intercepted in the worker and the
 * downloaded bytes are handed to the host instead.
 *
 * The bytes come from model-reachable code, so they are only written when
 * they are exactly a wheel Pyodide's lockfile names — same file name, same
 * SHA-256. Anything else is dropped. A refused or failed write only costs a
 * re-download next time; it never fails the import (Pyodide already has the
 * bytes in memory).
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rename, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import process from 'node:process';
import { pyodidePackageDir } from './spawn';

/** Per package directory. Only a lockfile that was read is remembered, so one
 *  unreadable at first (a volume still mounting) is retried on the next wheel. */
const lockedHashes = new Map<string, Map<string, string>>();

/** file_name → sha256 for every package in Pyodide's lockfile. */
function lockfileHashes(dir: string): Map<string, string> {
	const cached = lockedHashes.get(dir);
	if (cached) return cached;
	const map = new Map<string, string>();
	try {
		const lock = JSON.parse(readFileSync(join(dir, 'pyodide-lock.json'), 'utf8')) as {
			packages?: Record<string, { file_name?: unknown; sha256?: unknown }>;
		};
		for (const pkg of Object.values(lock.packages ?? {})) {
			if (typeof pkg.file_name === 'string' && typeof pkg.sha256 === 'string') {
				map.set(pkg.file_name, pkg.sha256.toLowerCase());
			}
		}
	} catch {
		// No lockfile → nothing is cacheable this time; imports still work uncached.
		return map;
	}
	lockedHashes.set(dir, map);
	return map;
}

/**
 * Write `bytes` into the Pyodide package directory as `requestedPath`'s file
 * name, if and only if that name and content match the lockfile. Returns
 * whether it was written. Only the base name of `requestedPath` is used, so
 * the worker cannot choose the directory.
 */
export async function cachePyodideWheel(
	requestedPath: string,
	bytes: Uint8Array,
	dir: string = pyodidePackageDir(),
): Promise<boolean> {
	const name = basename(requestedPath);
	const expected = lockfileHashes(dir).get(name);
	if (!expected) return false;
	const actual = createHash('sha256').update(bytes).digest('hex');
	if (actual !== expected) return false;
	const target = join(dir, name);
	const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
	try {
		await writeFile(tmp, bytes);
		await rename(tmp, target);
		return true;
	} catch {
		// Read-only install (e.g. a non-root container over a root-owned
		// node_modules): stay uncached.
		await unlink(tmp).catch(() => {});
		return false;
	}
}

/** Test-only: forget the parsed lockfile. */
export function resetPyodideWheelCacheForTests(): void {
	lockedHashes.clear();
}
