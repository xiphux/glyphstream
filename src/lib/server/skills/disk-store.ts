/**
 * Disk-backed SkillStore. A bundle lives at `${SKILLS_DIR}/<storagePath>/`
 * (storagePath = `<userId>/<name>`) holding the SKILL.md and any resources
 * exactly as uploaded.
 *
 * The security crux is path-jailing: `relPath` arguments come from the model
 * (read_skill_file) or an upload, so every resolved path is verified to stay
 * within the bundle root. We jail BOTH lexically (reject `..`/absolute/NUL,
 * check `path.relative` doesn't escape) AND, for reads, via realpath
 * containment (defeats symlink escape — a bundle could contain a symlink
 * pointing outside its directory). The code-interpreter's filename-only check
 * (`code-interpreter/worker.ts`) is insufficient here because skills live on
 * the host filesystem, not inside a WASM sandbox.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { skillsDir } from '../env';
import {
	MAX_BUNDLE_BYTES,
	MAX_BUNDLE_DEPTH,
	MAX_BUNDLE_FILE_BYTES,
	MAX_BUNDLE_FILES,
	MAX_LISTED_FILES,
	MAX_READ_FILE_BYTES,
	type SkillBundleFile,
	type SkillFileContent,
	type SkillStore,
} from './store';

function root(): string {
	const r = resolve(skillsDir());
	mkdirSync(r, { recursive: true });
	return r;
}

/**
 * Lexical jail: resolve `relPath` under `baseAbs` and confirm it doesn't
 * escape. Returns the absolute path, or null if the path is unsafe (absolute,
 * NUL, or traverses out via `..`). Does NOT touch the filesystem — callers
 * that read add a realpath containment check on top.
 */
export function safeJoin(baseAbs: string, relPath: string): string | null {
	if (!relPath || relPath.includes('\0')) return null;
	// Normalize separators so a Windows-style `..\` is caught too.
	const normalizedRel = relPath.replace(/\\/g, '/');
	if (isAbsolute(normalizedRel) || isAbsolute(relPath)) return null;
	const resolved = resolve(baseAbs, normalizedRel);
	const rel = relative(baseAbs, resolved);
	if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
	return resolved;
}

/** Depth of a bundle-relative path (number of path segments). */
function pathDepth(relPath: string): number {
	return relPath.replace(/\\/g, '/').split('/').filter(Boolean).length;
}

export class DiskSkillStore implements SkillStore {
	private absRoot(storagePath: string): string {
		// storagePath is server-constructed (`<userId>/<name>`), but jail it
		// anyway as defense-in-depth.
		const jailed = safeJoin(root(), storagePath);
		if (!jailed) throw new Error(`Unsafe skill storagePath: ${storagePath}`);
		return jailed;
	}

	async putBundle(storagePath: string, files: SkillBundleFile[]): Promise<void> {
		if (files.length === 0) throw new Error('A skill bundle must contain at least one file.');
		if (files.length > MAX_BUNDLE_FILES) {
			throw new Error(`Skill bundle exceeds ${MAX_BUNDLE_FILES} files.`);
		}
		let total = 0;
		for (const f of files) {
			if (f.bytes.byteLength > MAX_BUNDLE_FILE_BYTES) {
				throw new Error(`File "${f.relPath}" exceeds ${MAX_BUNDLE_FILE_BYTES} bytes.`);
			}
			if (pathDepth(f.relPath) > MAX_BUNDLE_DEPTH) {
				throw new Error(`File "${f.relPath}" nests deeper than ${MAX_BUNDLE_DEPTH} levels.`);
			}
			total += f.bytes.byteLength;
		}
		if (total > MAX_BUNDLE_BYTES) {
			throw new Error(`Skill bundle exceeds ${MAX_BUNDLE_BYTES} bytes total.`);
		}

		const finalAbs = this.absRoot(storagePath);
		const tmpAbs = `${finalAbs}.tmp-${randomUUID()}`;
		try {
			await rm(tmpAbs, { recursive: true, force: true });
			for (const f of files) {
				const dest = safeJoin(tmpAbs, f.relPath);
				if (!dest) throw new Error(`Unsafe bundle path: ${f.relPath}`);
				await mkdir(dirname(dest), { recursive: true });
				await writeFile(dest, f.bytes);
			}
			// Atomic-ish replace: drop the old bundle, then rename the temp in.
			await rm(finalAbs, { recursive: true, force: true });
			await mkdir(dirname(finalAbs), { recursive: true });
			await rename(tmpAbs, finalAbs);
		} catch (e) {
			await rm(tmpAbs, { recursive: true, force: true }).catch(() => {});
			throw e;
		}
	}

	async readSkillMd(storagePath: string): Promise<string | null> {
		const abs = join(this.absRoot(storagePath), 'SKILL.md');
		if (!existsSync(abs)) return null;
		return readFile(abs, 'utf8');
	}

	async readFile(storagePath: string, relPath: string): Promise<SkillFileContent | null> {
		const baseAbs = this.absRoot(storagePath);
		const jailed = safeJoin(baseAbs, relPath);
		if (!jailed) throw new Error('Path escapes the skill directory.');
		if (!existsSync(jailed)) return null;

		// Realpath containment: defeat a symlink inside the bundle pointing out.
		const [realBase, realTarget] = await Promise.all([realpath(baseAbs), realpath(jailed)]);
		if (realTarget !== realBase && !realTarget.startsWith(realBase + sep)) {
			throw new Error('Path escapes the skill directory.');
		}

		const info = await stat(realTarget);
		if (!info.isFile()) return null;
		if (info.size > MAX_READ_FILE_BYTES) {
			throw new Error(
				`File "${relPath}" is ${info.size} bytes, over the ${MAX_READ_FILE_BYTES}-byte read limit.`,
			);
		}
		const bytes = await readFile(realTarget);
		return { bytes, relPath: relative(baseAbs, jailed).split(sep).join('/') };
	}

	async listFiles(storagePath: string): Promise<string[]> {
		const baseAbs = this.absRoot(storagePath);
		if (!existsSync(baseAbs)) return [];
		const out: string[] = [];
		const walk = async (dirAbs: string, depth: number): Promise<void> => {
			if (out.length >= MAX_LISTED_FILES || depth > MAX_BUNDLE_DEPTH) return;
			let entries;
			try {
				entries = await readdir(dirAbs, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				if (out.length >= MAX_LISTED_FILES) return;
				const childAbs = join(dirAbs, entry.name);
				if (entry.isDirectory()) {
					await walk(childAbs, depth + 1);
				} else if (entry.isFile()) {
					out.push(relative(baseAbs, childAbs).split(sep).join('/'));
				}
			}
		};
		await walk(baseAbs, 1);
		return out.sort();
	}

	async moveBundle(oldStoragePath: string, newStoragePath: string): Promise<void> {
		const oldAbs = this.absRoot(oldStoragePath);
		const newAbs = this.absRoot(newStoragePath);
		if (!existsSync(oldAbs)) return;
		await mkdir(dirname(newAbs), { recursive: true });
		await rm(newAbs, { recursive: true, force: true });
		await rename(oldAbs, newAbs);
	}

	async deleteBundle(storagePath: string): Promise<void> {
		const abs = this.absRoot(storagePath);
		try {
			await rm(abs, { recursive: true, force: true });
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
				console.warn(`[skill-store] deleteBundle(${storagePath}) failed:`, e);
			}
		}
	}
}

let cached: DiskSkillStore | null = null;
export function getSkillStore(): SkillStore {
	if (!cached) cached = new DiskSkillStore();
	return cached;
}
