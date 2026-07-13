/**
 * Helpers for running a skill's bundled Python script in the code-interpreter
 * (Pyodide) sandbox. Pure + I/O-via-injected-store, so unit-testable.
 *
 * The worker's `/workspace` is FLAT (no subdirectories — see worker.ts
 * `isSafeWorkspaceFilename`), so we flatten the entry script and its
 * same-directory `.py` siblings to their basenames. `runpy.run_path` puts the
 * script's dir (`/workspace`) on `sys.path`, so `import sibling` then resolves.
 * Nested package imports (`from scripts.helpers import x`) are NOT supported.
 */
import { createHash } from 'node:crypto';
import type { RunPythonPreFile } from '../code-interpreter/pool';
import type { SkillStore } from './store';

/** Defensive cap on how many sibling `.py` files we materialize. */
export const MAX_SCRIPT_SIBLINGS = 50;

/** POSIX dirname over a `/`-separated bundle path ('' for a root-level file).
 *  Bundle paths from `listFiles` always use `/`, so do NOT use node path.* . */
function posixDir(p: string): string {
	const i = p.lastIndexOf('/');
	return i < 0 ? '' : p.slice(0, i);
}
function posixBase(p: string): string {
	const i = p.lastIndexOf('/');
	return i < 0 ? p : p.slice(i + 1);
}

export interface MaterializedScript {
	entryBasename: string;
	preFiles: RunPythonPreFile[];
}

export type MaterializeResult =
	{ ok: true; value: MaterializedScript } | { ok: false; error: string };

/**
 * Read the entry script + its same-directory `.py` siblings from a skill bundle
 * and turn them into flat `RunPythonPreFile`s (basenamed). Returns a structured
 * error (never throws) so the tool surfaces it as a recoverable result.
 */
export async function materializeSkillScript(
	store: SkillStore,
	storagePath: string,
	path: string,
): Promise<MaterializeResult> {
	const dir = posixDir(path);

	let all: string[];
	try {
		all = await store.listFiles(storagePath);
	} catch (e) {
		return { ok: false, error: (e as Error).message };
	}

	// Same-directory `.py` files (includes the entry itself).
	const siblings = all.filter((p) => posixDir(p) === dir && p.toLowerCase().endsWith('.py'));
	if (!siblings.includes(path)) {
		return { ok: false, error: `No script at "${path}" in this skill.` };
	}
	if (siblings.length > MAX_SCRIPT_SIBLINGS) {
		return {
			ok: false,
			error: `Too many .py files alongside the script (${siblings.length} > ${MAX_SCRIPT_SIBLINGS}).`,
		};
	}

	const preFiles: RunPythonPreFile[] = [];
	for (const rel of siblings) {
		let file;
		try {
			file = await store.readFile(storagePath, rel);
		} catch (e) {
			return { ok: false, error: `Could not read "${rel}": ${(e as Error).message}` };
		}
		if (file === null) continue; // listed but vanished (race) — skip.
		const u8 = new Uint8Array(file.bytes.buffer, file.bytes.byteOffset, file.bytes.byteLength);
		preFiles.push({
			filename: posixBase(rel),
			bytes: u8,
			sha256: createHash('sha256').update(u8).digest('hex'),
		});
	}

	const entryBasename = posixBase(path);
	if (!preFiles.some((f) => f.filename === entryBasename)) {
		return { ok: false, error: `No script at "${path}" in this skill.` };
	}
	return { ok: true, value: { entryBasename, preFiles } };
}

/** Dedupe pre-files by basename, keeping the LAST occurrence. Used to merge
 *  conversation files with skill files so the skill's own files win on a
 *  basename collision (call with `[...conversationFiles, ...skillFiles]`). */
export function dedupeByFilename(preFiles: RunPythonPreFile[]): RunPythonPreFile[] {
	const byName = new Map<string, RunPythonPreFile>();
	for (const f of preFiles) byName.set(f.filename, f);
	return [...byName.values()];
}

/**
 * The Python entry the worker runs. `runpy.run_path(..., run_name='__main__')`
 * runs the script as `__main__` (so `if __name__ == '__main__':` fires) in a
 * fresh namespace — its globals don't leak into the conversation's persistent
 * interpreter. The entry name + argv ride a base64'd JSON blob so no
 * user-controlled data is interpolated into the Python source — only the base64
 * string is, and its `[A-Za-z0-9+/=]` charset can't contain the single-quote
 * delimiter, so it's injection-safe even for odd skill filenames. A trailing
 * `None` keeps the returned `value` clean (run_path otherwise returns the
 * module-globals dict).
 */
export function buildScriptBootstrap(entryBasename: string, args: string[]): string {
	const b64 = Buffer.from(JSON.stringify({ entry: entryBasename, args }), 'utf8').toString(
		'base64',
	);
	return [
		'import sys, json, base64, runpy',
		`_cfg = json.loads(base64.b64decode('${b64}').decode())`,
		"sys.argv = [_cfg['entry'], *_cfg['args']]",
		"runpy.run_path('/workspace/' + _cfg['entry'], run_name='__main__')",
		'None',
	].join('\n');
}
