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
	systemPrompt: '',
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
		systemPrompt: typeof obj.systemPrompt === 'string' ? obj.systemPrompt : DEFAULTS.systemPrompt,
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
			systemPrompt:
				typeof patch.systemPrompt === 'string' ? patch.systemPrompt : current.systemPrompt,
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
