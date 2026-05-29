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
	enterBehavior: 'send',
	showGreeting: true,
	theme: 'glyphstream',
	notificationsEnabled: false,
	notificationsShowContent: false,
	notificationsForegroundToast: true,
	favoriteModels: []
};

/**
 * Coerce a candidate favoriteModels value to a clean string[]. Accepts only
 * an array whose entries are all strings — a mixed array indicates a bug
 * upstream rather than recoverable noise, and silently filtering bad
 * elements would hide it. De-dupes while preserving first-occurrence order
 * (insertion order is the user-visible ordering in sidebar + picker).
 */
function coerceFavoriteModels(input: unknown, fallback: string[]): string[] {
	if (!Array.isArray(input)) return fallback;
	if (!input.every((v) => typeof v === 'string')) return fallback;
	const seen = new Set<string>();
	const out: string[] = [];
	for (const v of input as string[]) {
		if (seen.has(v)) continue;
		seen.add(v);
		out.push(v);
	}
	return out;
}

/**
 * Coerce a loosely-typed input object into a complete UserPreferences,
 * validating each field and falling back per-field to `fallback`. The
 * single home for the field list — shared by parseUserPreferences
 * (fallback = DEFAULTS, input = raw parsed JSON) and setUserPreferences
 * (fallback = current prefs, input = the patch). Adding a preference is
 * one edit here instead of two parallel ones.
 */
function coerceUserPreferences(
	input: Partial<Record<keyof UserPreferences, unknown>>,
	fallback: UserPreferences
): UserPreferences {
	return {
		name: typeof input.name === 'string' ? input.name : fallback.name,
		aboutYou: typeof input.aboutYou === 'string' ? input.aboutYou : fallback.aboutYou,
		customInstructions:
			typeof input.customInstructions === 'string'
				? input.customInstructions
				: fallback.customInstructions,
		enterBehavior:
			input.enterBehavior === 'newline' || input.enterBehavior === 'send'
				? input.enterBehavior
				: fallback.enterBehavior,
		showGreeting:
			typeof input.showGreeting === 'boolean' ? input.showGreeting : fallback.showGreeting,
		theme:
			input.theme === 'glyphstream' || input.theme === 'claude' || input.theme === 'chatgpt'
				? input.theme
				: fallback.theme,
		notificationsEnabled:
			typeof input.notificationsEnabled === 'boolean'
				? input.notificationsEnabled
				: fallback.notificationsEnabled,
		notificationsShowContent:
			typeof input.notificationsShowContent === 'boolean'
				? input.notificationsShowContent
				: fallback.notificationsShowContent,
		notificationsForegroundToast:
			typeof input.notificationsForegroundToast === 'boolean'
				? input.notificationsForegroundToast
				: fallback.notificationsForegroundToast,
		favoriteModels:
			input.favoriteModels === undefined
				? fallback.favoriteModels
				: coerceFavoriteModels(input.favoriteModels, fallback.favoriteModels)
	};
}

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
	return coerceUserPreferences(parsed as Record<string, unknown>, DEFAULTS);
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
		const next = coerceUserPreferences(patch, current);
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
