/**
 * Skill rows are the per-user catalog index for on-disk skill bundles. Like
 * memories, every WHERE scopes by user_id so a tool call that fabricates a
 * foreign name/id can never reach another user's skill — the lookup simply
 * matches zero rows and the caller reports a recoverable error to the model.
 *
 * `name` + `description` are denormalized here from the SKILL.md frontmatter at
 * import time so the Tier-1 catalog (injected into every request's system
 * prompt) is a cheap indexed read. The body + bundled resources live on disk
 * (see `skills/disk-store.ts`), read only on activation. `storagePath`
 * (`<userId>/<name>`) is the on-disk bundle key.
 */
import { and, asc, eq } from 'drizzle-orm';
import { generateId } from '../../util/id';
import type { Skill } from '$lib/types/api';
import { getDb } from '../client';
import { skills } from '../schema';

export type { Skill };

/** Catalog-index fields the activation path needs (incl. the on-disk key). */
export interface SkillRef {
	id: string;
	name: string;
	description: string;
	storagePath: string;
}

/** The on-disk bundle key for a user's skill. The directory is named after the
 *  skill (the spec requires frontmatter `name` to match the parent dir). */
export function skillStoragePath(userId: string, name: string): string {
	return `${userId}/${name}`;
}

function rowToSkill(row: typeof skills.$inferSelect): Skill {
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		enabled: row.enabled === 1,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

/** All of a user's skills, oldest-first (stable ordering for the settings UI). */
export function listSkillsForUser(userId: string): Skill[] {
	const db = getDb();
	return db
		.select()
		.from(skills)
		.where(eq(skills.userId, userId))
		.orderBy(asc(skills.createdAt))
		.all()
		.map(rowToSkill);
}

/** Enabled skills only — the source for both the injected catalog and the
 *  activate_skill enum. Oldest-first for stable catalog ordering. */
export function listEnabledSkillsForUser(userId: string): Skill[] {
	const db = getDb();
	return db
		.select()
		.from(skills)
		.where(and(eq(skills.userId, userId), eq(skills.enabled, 1)))
		.orderBy(asc(skills.createdAt))
		.all()
		.map(rowToSkill);
}

/** Resolve an enabled skill by name for activation. userId-scoped, so a
 *  fabricated name can't reach another user's bundle. Returns null when no
 *  enabled skill matches. */
export function getEnabledSkillByName(userId: string, name: string): SkillRef | null {
	const db = getDb();
	const row = db
		.select()
		.from(skills)
		.where(and(eq(skills.userId, userId), eq(skills.name, name), eq(skills.enabled, 1)))
		.get();
	if (!row) return null;
	return { id: row.id, name: row.name, description: row.description, storagePath: row.storagePath };
}

/** Whether the user already has a skill by this name (any enabled state).
 *  Used by the import path to reject duplicates BEFORE overwriting the on-disk
 *  bundle — the unique index is the ultimate guard, but a pre-check avoids the
 *  overwrite-then-rollback corruption window. */
export function skillExistsByName(userId: string, name: string): boolean {
	const db = getDb();
	const row = db
		.select({ id: skills.id })
		.from(skills)
		.where(and(eq(skills.userId, userId), eq(skills.name, name)))
		.get();
	return row !== undefined;
}

export interface CreateSkillInput {
	userId: string;
	name: string;
	description: string;
	storagePath: string;
}

/**
 * Insert a skill catalog row. Throws on a unique (user_id, name) collision —
 * the API route maps that to a 409. Disk write of the bundle happens
 * separately (route orchestrates: putBundle, then createSkill).
 */
export function createSkill(input: CreateSkillInput): Skill {
	const db = getDb();
	const id = generateId();
	const now = Date.now();
	db.insert(skills)
		.values({
			id,
			userId: input.userId,
			name: input.name,
			description: input.description,
			storagePath: input.storagePath,
			enabled: 1,
			createdAt: now,
			updatedAt: now,
		})
		.run();
	return {
		id,
		name: input.name,
		description: input.description,
		enabled: true,
		createdAt: now,
		updatedAt: now,
	};
}

/** Toggle a skill's enabled flag. Returns true iff a row matched. */
export function setSkillEnabled(userId: string, id: string, enabled: boolean): boolean {
	const db = getDb();
	const result = db
		.update(skills)
		.set({ enabled: enabled ? 1 : 0, updatedAt: Date.now() })
		.where(and(eq(skills.userId, userId), eq(skills.id, id)))
		.run();
	return result.changes > 0;
}

/** Delete a skill row, returning its storagePath so the caller can remove the
 *  on-disk bundle after the DB delete commits. Null if no row matched. */
export function deleteSkill(userId: string, id: string): { storagePath: string } | null {
	const db = getDb();
	const row = db
		.select({ storagePath: skills.storagePath })
		.from(skills)
		.where(and(eq(skills.userId, userId), eq(skills.id, id)))
		.get();
	if (!row) return null;
	db.delete(skills)
		.where(and(eq(skills.userId, userId), eq(skills.id, id)))
		.run();
	return { storagePath: row.storagePath };
}

/**
 * Compose the `<available_skills>` catalog (Tier 1) appended to the system
 * prompt. Returns null when empty so the caller omits the block entirely (an
 * empty catalog would just confuse the model). Mirrors `composeMemorySection`.
 *
 * Each skill is one `name — description` line. The header teaches the model the
 * progressive-disclosure contract: call activate_skill(name) to load full
 * instructions when a task matches. Keys on `name` (the activation arg + enum).
 */
export function composeSkillsCatalog(list: Pick<Skill, 'name' | 'description'>[]): string | null {
	if (list.length === 0) return null;
	const header =
		'Available skills (reusable capabilities you can load on demand). When a task matches a skill below, call the activate_skill tool with its name to load the full instructions before proceeding; then, if those instructions reference a bundled file, call read_skill_file to load it. Do not re-activate a skill already loaded in this conversation.';
	const lines = list.map((s) => `- ${s.name} — ${s.description}`);
	return `<available_skills>\n${header}\n\n${lines.join('\n')}\n</available_skills>`;
}
