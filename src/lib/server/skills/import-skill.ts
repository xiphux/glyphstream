/**
 * Skill import orchestration — turn an uploaded bundle (or a pasted SKILL.md)
 * into an on-disk bundle + a catalog row. Route-agnostic and unit-testable: the
 * API route's only job is to marshal the request into `SkillBundleFile[]`.
 *
 * Ordering matters for correctness: insert the catalog row BEFORE writing the
 * bundle. `createSkill`'s synchronous `unique(userId, name)` index makes a
 * concurrent same-name loser fail at the INSERT — before it touches disk — so
 * it can never clobber the winner's bundle (both share the deterministic
 * `<userId>/<name>` path, which `putBundle` replaces wholesale). On a bundle
 * write failure we roll back the row we just inserted. `skillExistsByName` stays
 * as a friendly pre-flight 409 for the common re-import case.
 */
import type { Skill } from '$lib/types/api';
import {
	createSkill,
	deleteSkill,
	skillExistsByName,
	skillStoragePath,
} from '../db/queries/skills';
import { getSkillStore } from './disk-store';
import { parseSkillMd } from './parse-skill-md';
import type { SkillBundleFile } from './store';

export type ImportSkillResult =
	| { ok: true; skill: Skill }
	| { ok: false; status: number; error: string };

/** Normalize uploaded bundle paths: forward-slash separators, drop a single
 *  common leading directory (a folder upload yields `my-skill/SKILL.md`), and
 *  reject anything that escapes. Returns the cleaned files, or an error. */
export function normalizeBundleFiles(
	files: SkillBundleFile[],
): { ok: true; files: SkillBundleFile[] } | { ok: false; error: string } {
	if (files.length === 0) return { ok: false, error: 'No files were uploaded.' };

	const cleaned = files.map((f) => ({
		relPath: f.relPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, ''),
		bytes: f.bytes,
	}));

	for (const f of cleaned) {
		if (!f.relPath || f.relPath.split('/').some((seg) => seg === '..' || seg === '')) {
			return { ok: false, error: `Unsafe file path in bundle: "${f.relPath}".` };
		}
	}

	// Strip a single shared top-level directory (the selected folder), but only
	// when every file shares it — a bundle uploaded as loose files at root has
	// no common dir to strip.
	const firstSegs = new Set(cleaned.map((f) => f.relPath.split('/')[0]));
	const hasSubdirs = cleaned.some((f) => f.relPath.includes('/'));
	if (firstSegs.size === 1 && hasSubdirs) {
		const prefix = `${[...firstSegs][0]}/`;
		const allSharePrefix = cleaned.every((f) => f.relPath.startsWith(prefix));
		if (allSharePrefix) {
			for (const f of cleaned) f.relPath = f.relPath.slice(prefix.length);
		}
	}

	return { ok: true, files: cleaned };
}

interface UniqueViolation {
	code?: string;
	message?: string;
}

function isUniqueViolation(e: unknown): boolean {
	const err = e as UniqueViolation;
	return (
		err?.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
		(typeof err?.message === 'string' && err.message.includes('UNIQUE constraint failed'))
	);
}

/**
 * Import a bundle for a user. `files` paths are bundle-relative; a SKILL.md
 * must exist at the root. Returns a discriminated result the route maps to an
 * HTTP status.
 */
export async function importSkillBundle(
	userId: string,
	rawFiles: SkillBundleFile[],
): Promise<ImportSkillResult> {
	const normalized = normalizeBundleFiles(rawFiles);
	if (!normalized.ok) return { ok: false, status: 400, error: normalized.error };
	const files = normalized.files;

	const skillMd = files.find((f) => f.relPath === 'SKILL.md');
	if (!skillMd) {
		return { ok: false, status: 400, error: 'The bundle must contain a SKILL.md at its root.' };
	}

	const parsed = parseSkillMd(skillMd.bytes.toString('utf8'));
	if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
	const { name, description } = parsed.skill;

	if (skillExistsByName(userId, name)) {
		return {
			ok: false,
			status: 409,
			error: `A skill named "${name}" already exists. Delete it before re-importing.`,
		};
	}

	const storagePath = skillStoragePath(userId, name);

	// Insert the row first: the unique index rejects a concurrent same-name
	// loser here, synchronously, before any disk write — so the loser can't
	// clobber the winner's bundle at the shared path.
	let skill: Skill;
	try {
		skill = createSkill({ userId, name, description, storagePath });
	} catch (e) {
		if (isUniqueViolation(e)) {
			return { ok: false, status: 409, error: `A skill named "${name}" already exists.` };
		}
		throw e;
	}

	// Then write the bundle; if that fails, roll back the row we just inserted
	// so we never leave a catalog entry with no bundle on disk.
	try {
		await getSkillStore().putBundle(storagePath, files);
	} catch (e) {
		deleteSkill(userId, skill.id);
		return { ok: false, status: 400, error: (e as Error).message };
	}

	return { ok: true, skill };
}
