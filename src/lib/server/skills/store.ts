/**
 * SkillStore — the storage abstraction for skill *bundles* (a SKILL.md plus
 * any bundled resource files/subdirectories), kept verbatim as uploaded.
 *
 * Mirrors the MediaStore split: bytes live on disk (or, later, S3) keyed by a
 * `storagePath`, while the DB holds only the catalog index. Swapping in an
 * S3-backed implementation is a single new file behind this interface, exactly
 * like `MediaStore`.
 *
 * `storagePath` is the bundle's directory key — `<userId>/<name>` for the disk
 * store. `relPath` arguments are paths WITHIN a bundle and are treated as
 * untrusted (the model supplies them to read_skill_file): implementations MUST
 * jail them to the bundle root.
 */

export interface SkillBundleFile {
	/** Path relative to the bundle root, e.g. `SKILL.md` or `references/api.md`. */
	relPath: string;
	bytes: Buffer;
}

export interface SkillFileContent {
	bytes: Buffer;
	/** Path relative to the bundle root (normalized). */
	relPath: string;
}

export interface SkillStore {
	/** Write a bundle's files, replacing any existing bundle at `storagePath`
	 *  atomically (temp dir + rename). Rejects unsafe relPaths and enforces
	 *  file-count / size / depth bounds. */
	putBundle(storagePath: string, files: SkillBundleFile[]): Promise<void>;
	/** Raw SKILL.md text, or null if the bundle/file is absent. */
	readSkillMd(storagePath: string): Promise<string | null>;
	/** Read one bundled file, path-jailed to the bundle root. Returns null when
	 *  the path is absent; throws on an escape attempt or an over-size file. */
	readFile(storagePath: string, relPath: string): Promise<SkillFileContent | null>;
	/** Bounded listing of bundle-relative file paths (for the resource
	 *  manifest surfaced on activation). Capped in count + depth. */
	listFiles(storagePath: string): Promise<string[]>;
	/** Move a bundle (skill rename). No-op if the source is absent. */
	moveBundle(oldStoragePath: string, newStoragePath: string): Promise<void>;
	/** Recursively remove a bundle. Best-effort; never throws on ENOENT. */
	deleteBundle(storagePath: string): Promise<void>;
}

// Structural bounds — defend against pathological uploads (the spec recommends
// bounding scans/bundles). Tuned for instructions-only skills: a SKILL.md plus
// a handful of reference docs / scripts, not a vendored dependency tree.
export const MAX_BUNDLE_FILES = 200;
export const MAX_BUNDLE_BYTES = 5 * 1024 * 1024; // 5 MiB total per bundle
export const MAX_BUNDLE_FILE_BYTES = 2 * 1024 * 1024; // 2 MiB per file
export const MAX_BUNDLE_DEPTH = 8;
/** Cap on bytes returned by a single read_skill_file call (model-facing). */
export const MAX_READ_FILE_BYTES = 256 * 1024;
/** Cap on the resource manifest length surfaced on activation. */
export const MAX_LISTED_FILES = 100;
