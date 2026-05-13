/**
 * User preferences live as a JSON blob on the users row. This file is the
 * sole boundary between the raw JSON string (what's in the DB) and the
 * strongly-typed `UserPreferences` object (what the rest of the app sees).
 *
 * Defensive parsing is the key design choice: a corrupted blob, a JSON
 * field we don't recognize, an older deployment's shape — all fall back
 * to the DEFAULTS rather than throwing. Adding a new preference here is
 * the only change needed; no migration, no schema update.
 */

import { eq } from 'drizzle-orm';
import type { UserPreferences } from '$lib/types/api';
import { getDb } from '../client';
import { users } from '../schema';

const DEFAULTS: UserPreferences = {
	name: '',
	aboutYou: '',
	customInstructions: '',
	enterBehavior: 'send'
};

/** Pure: parse a raw JSON string into a UserPreferences object, filling in
 * defaults for absent / invalid / malformed fields. Never throws. */
export function parseUserPreferences(raw: string | null): UserPreferences {
	if (!raw) return { ...DEFAULTS };
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { ...DEFAULTS };
	}
	if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULTS };
	const obj = parsed as Record<string, unknown>;
	return {
		name: typeof obj.name === 'string' ? obj.name : DEFAULTS.name,
		aboutYou: typeof obj.aboutYou === 'string' ? obj.aboutYou : DEFAULTS.aboutYou,
		customInstructions:
			typeof obj.customInstructions === 'string'
				? obj.customInstructions
				: DEFAULTS.customInstructions,
		enterBehavior:
			obj.enterBehavior === 'newline' || obj.enterBehavior === 'send'
				? obj.enterBehavior
				: DEFAULTS.enterBehavior
	};
}

/** Read the user's preferences from the DB, returning defaults if the row
 * exists but the preferences_json field is null/empty. Returns null only
 * if the user doesn't exist (which should never happen for an authenticated
 * caller — but treat it as null defensively). */
export function getUserPreferences(userId: string): UserPreferences | null {
	const db = getDb();
	const row = db
		.select({ preferencesJson: users.preferencesJson })
		.from(users)
		.where(eq(users.id, userId))
		.get();
	if (!row) return null;
	return parseUserPreferences(row.preferencesJson);
}

/**
 * Partially update preferences. Read-modify-write inside a transaction:
 * pull the current JSON, parse to typed object, overlay the patch fields,
 * serialize, write. The merge happens on the typed object so a malformed
 * stored blob doesn't propagate corruption (the parser's defaults kick in
 * on read, and the write produces a clean blob).
 */
export function setUserPreferences(
	userId: string,
	patch: Partial<UserPreferences>
): UserPreferences {
	const db = getDb();
	return db.transaction((tx) => {
		const row = tx
			.select({ preferencesJson: users.preferencesJson })
			.from(users)
			.where(eq(users.id, userId))
			.get();
		const current = parseUserPreferences(row?.preferencesJson ?? null);
		const next: UserPreferences = {
			name: typeof patch.name === 'string' ? patch.name : current.name,
			aboutYou: typeof patch.aboutYou === 'string' ? patch.aboutYou : current.aboutYou,
			customInstructions:
				typeof patch.customInstructions === 'string'
					? patch.customInstructions
					: current.customInstructions,
			enterBehavior:
				patch.enterBehavior === 'newline' || patch.enterBehavior === 'send'
					? patch.enterBehavior
					: current.enterBehavior
		};
		tx.update(users)
			.set({ preferencesJson: JSON.stringify(next) })
			.where(eq(users.id, userId))
			.run();
		return next;
	});
}

/**
 * Compose the three personalization fields into a single system prompt
 * for the model. Each non-empty field becomes its own labeled section;
 * empty fields are omitted (no "Name: (blank)" leaks). Returns null when
 * all three are empty — the caller (conversation-create handler) treats
 * null as "no system prompt for this conversation."
 *
 * The labels are intentionally plain English rather than YAML/JSON keys:
 * we're authoring instructions for the model to read, and natural-
 * language section headers prime it better than a structured envelope
 * that the model has to parse.
 */
export function composePersonaSystemPrompt(prefs: UserPreferences): string | null {
	const parts: string[] = [];
	const name = prefs.name.trim();
	const about = prefs.aboutYou.trim();
	const custom = prefs.customInstructions.trim();
	if (name) {
		parts.push(`The user's name is ${name}. Refer to them by this name when natural.`);
	}
	if (about) {
		parts.push(`About the user:\n${about}`);
	}
	if (custom) {
		parts.push(`Additional instructions:\n${custom}`);
	}
	return parts.length === 0 ? null : parts.join('\n\n');
}
