import { createLogger } from '../log';

const log = createLogger('code-interpreter');
/**
 * The rules for files a Python run hands back out of /workspace/, shared by
 * the interpreter process (which applies them while diffing the workspace)
 * and the host (which applies them again on receipt). The process runs
 * model-written code that can post its own `result` message, so its word on
 * names and sizes is not the boundary; the host's re-check is.
 */

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
export const MAX_GENERATED_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_GENERATED_TOTAL_BYTES = 50 * 1024 * 1024;

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
export function isSafeWorkspaceFilename(name: string): boolean {
	if (!name) return false;
	if (name === '.' || name === '..') return false;
	if (name.includes('/') || name.includes('\\') || name.includes('\0')) return false;
	return true;
}

export interface GeneratedFile {
	filename: string;
	bytes: Uint8Array;
	sha256: string;
}

/**
 * The host-side check of a run's `newFiles`: keeps entries with a safe name
 * and byte content, within the per-file and total caps, and drops the rest
 * with a log line. Never throws on a malformed list.
 */
export function acceptGeneratedFiles(raw: unknown): GeneratedFile[] {
	if (!Array.isArray(raw)) return [];
	const accepted: GeneratedFile[] = [];
	let total = 0;
	for (const f of raw as unknown[]) {
		const { filename, bytes, sha256 } = (f ?? {}) as Record<string, unknown>;
		if (typeof filename !== 'string' || !isSafeWorkspaceFilename(filename)) continue;
		if (!(bytes instanceof Uint8Array)) continue;
		if (
			bytes.byteLength > MAX_GENERATED_FILE_BYTES ||
			total + bytes.byteLength > MAX_GENERATED_TOTAL_BYTES
		) {
			log.warn(`host dropped generated file ${filename}: over the size cap`);
			continue;
		}
		total += bytes.byteLength;
		accepted.push({ filename, bytes, sha256: typeof sha256 === 'string' ? sha256 : '' });
	}
	return accepted;
}
