/**
 * The host writes a Pyodide wheel the interpreter downloaded only when it is
 * byte-for-byte a wheel the lockfile names. The bytes arrive from the
 * interpreter process, which runs model-written code, so anything else must
 * be refused rather than written into the package directory.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
	cachePyodideWheel,
	resetPyodideWheelCacheForTests,
} from '../../src/lib/server/code-interpreter/package-cache';

const wheel = new TextEncoder().encode('pretend wheel bytes');
const sha = createHash('sha256').update(wheel).digest('hex');

let dir: string;
beforeEach(() => {
	resetPyodideWheelCacheForTests();
	dir = mkdtempSync(join(tmpdir(), 'pyodide-cache-'));
	writeFileSync(
		join(dir, 'pyodide-lock.json'),
		JSON.stringify({ packages: { demo: { file_name: 'demo-1.0-py3-none-any.whl', sha256: sha } } }),
	);
});

describe('cachePyodideWheel', () => {
	it('writes a wheel whose name and hash match the lockfile', async () => {
		expect(await cachePyodideWheel(join(dir, 'demo-1.0-py3-none-any.whl'), wheel, dir)).toBe(true);
		expect(readFileSync(join(dir, 'demo-1.0-py3-none-any.whl'))).toEqual(Buffer.from(wheel));
	});

	it('refuses bytes that do not match the locked hash', async () => {
		const tampered = new TextEncoder().encode('something else');
		expect(await cachePyodideWheel(join(dir, 'demo-1.0-py3-none-any.whl'), tampered, dir)).toBe(
			false,
		);
		expect(readdirSync(dir)).toEqual(['pyodide-lock.json']);
	});

	it('refuses a file name the lockfile does not list', async () => {
		expect(await cachePyodideWheel(join(dir, 'evil.whl'), wheel, dir)).toBe(false);
		expect(readdirSync(dir)).toEqual(['pyodide-lock.json']);
	});

	it('ignores the directory the interpreter asked for', async () => {
		const elsewhere = mkdtempSync(join(tmpdir(), 'pyodide-elsewhere-'));
		expect(await cachePyodideWheel(join(elsewhere, 'demo-1.0-py3-none-any.whl'), wheel, dir)).toBe(
			true,
		);
		expect(readdirSync(elsewhere)).toEqual([]);
		expect(readdirSync(dir)).toContain('demo-1.0-py3-none-any.whl');
	});

	it('reads the lockfile again after a failed read, and per directory', async () => {
		const late = mkdtempSync(join(tmpdir(), 'pyodide-late-'));
		expect(await cachePyodideWheel('demo-1.0-py3-none-any.whl', wheel, late)).toBe(false);
		writeFileSync(join(late, 'pyodide-lock.json'), readFileSync(join(dir, 'pyodide-lock.json')));
		expect(await cachePyodideWheel('demo-1.0-py3-none-any.whl', wheel, late)).toBe(true);
		// A directory read earlier doesn't answer for another one.
		expect(await cachePyodideWheel('demo-1.0-py3-none-any.whl', wheel, dir)).toBe(true);
	});
});
