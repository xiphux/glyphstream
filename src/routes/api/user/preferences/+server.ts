/**
 * GET /api/user/preferences      — fetch the caller's preferences.
 * PATCH /api/user/preferences    — partial update.
 *
 * The query layer (queries/user-preferences.ts) does the heavy lifting:
 * defensive parsing on read, typed merge + clean serialization on write.
 * This handler just validates the request shape and delegates.
 *
 * Returns the full preferences object on both methods so the client can
 * sync its state without a follow-up GET.
 */

import { error, json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import { parseJsonBody } from '$lib/server/http';
import { getUserPreferences, setUserPreferences } from '$lib/server/db/queries/user-preferences';
import type {
	ColorScheme,
	EnterBehavior,
	SavedModelSet,
	ThemeName,
	UserPreferences,
} from '$lib/types/api';
import type { RequestHandler } from './$types';

const THEME_NAMES: readonly ThemeName[] = ['glyphstream', 'claude', 'chatgpt'];
const COLOR_SCHEMES: readonly ColorScheme[] = ['system', 'light', 'dark'];

export const GET: RequestHandler = ({ locals }) => {
	requireUser(locals);
	const prefs = getUserPreferences(locals.user.id);
	if (!prefs) throw error(404, 'User not found');
	return json(prefs);
};

export const PATCH: RequestHandler = async ({ locals, request, cookies }) => {
	requireUser(locals);

	const body = await parseJsonBody<Partial<UserPreferences>>(request);

	// Build a narrowed patch object — explicitly validate each field rather
	// than passing the unsanitized body to the query, so the query layer
	// only ever sees known-good values. (The query itself is also
	// defensive, but defense-in-depth is cheap here.)
	const patch: Partial<UserPreferences> = {};
	if (typeof body.name === 'string') patch.name = body.name;
	if (typeof body.aboutYou === 'string') patch.aboutYou = body.aboutYou;
	if (typeof body.customInstructions === 'string') {
		patch.customInstructions = body.customInstructions;
	}
	if (body.enterBehavior !== undefined) {
		if (body.enterBehavior !== 'send' && body.enterBehavior !== 'newline') {
			throw error(400, `Invalid enterBehavior "${body.enterBehavior as string}"`);
		}
		patch.enterBehavior = body.enterBehavior as EnterBehavior;
	}
	if (typeof body.showGreeting === 'boolean') {
		patch.showGreeting = body.showGreeting;
	}
	if (body.theme !== undefined) {
		if (!THEME_NAMES.includes(body.theme as ThemeName)) {
			throw error(400, `Invalid theme "${body.theme as string}"`);
		}
		patch.theme = body.theme as ThemeName;
	}
	if (body.colorScheme !== undefined) {
		if (!COLOR_SCHEMES.includes(body.colorScheme as ColorScheme)) {
			throw error(400, `Invalid colorScheme "${body.colorScheme as string}"`);
		}
		patch.colorScheme = body.colorScheme as ColorScheme;
	}
	if (typeof body.notificationsEnabled === 'boolean') {
		patch.notificationsEnabled = body.notificationsEnabled;
	}
	if (typeof body.notificationsShowContent === 'boolean') {
		patch.notificationsShowContent = body.notificationsShowContent;
	}
	if (typeof body.notificationsForegroundToast === 'boolean') {
		patch.notificationsForegroundToast = body.notificationsForegroundToast;
	}
	if (body.favoriteModels !== undefined) {
		if (
			!Array.isArray(body.favoriteModels) ||
			!body.favoriteModels.every((v): v is string => typeof v === 'string')
		) {
			throw error(400, 'favoriteModels must be a string[]');
		}
		patch.favoriteModels = body.favoriteModels;
	}
	if (body.modelSets !== undefined) {
		// Validate the shape only — model-id existence is intentionally not
		// checked (a removed endpoint's id is still a valid string; it degrades
		// at expand time, like favoriteModels). The query layer re-coerces on
		// write (dedupe/trim/drop-empty), so this is the cheap first gate.
		if (
			!Array.isArray(body.modelSets) ||
			!body.modelSets.every(
				(s): s is SavedModelSet =>
					typeof s === 'object' &&
					s !== null &&
					typeof (s as SavedModelSet).id === 'string' &&
					typeof (s as SavedModelSet).name === 'string' &&
					(s as SavedModelSet).name.trim() !== '' &&
					Array.isArray((s as SavedModelSet).models) &&
					(s as SavedModelSet).models.every(
						(m) =>
							typeof m === 'object' &&
							m !== null &&
							typeof m.modelId === 'string' &&
							typeof m.count === 'number' &&
							Number.isInteger(m.count) &&
							m.count >= 1,
					),
			)
		) {
			throw error(400, 'modelSets must be { id, name, models: {modelId, count>=1}[] }[]');
		}
		patch.modelSets = body.modelSets;
	}

	const next = setUserPreferences(locals.user.id, patch);
	// Mirror the theme into a non-httpOnly cookie so hooks.server.ts can
	// apply it before first paint on the next load (no flash). The DB pref
	// stays the source of truth; this is just a fast pre-render read.
	cookies.set('gs-theme', next.theme, {
		path: '/',
		maxAge: 60 * 60 * 24 * 365,
		httpOnly: false,
		sameSite: 'lax',
	});
	cookies.set('gs-scheme', next.colorScheme, {
		path: '/',
		maxAge: 60 * 60 * 24 * 365,
		httpOnly: false,
		sameSite: 'lax',
	});
	return json(next);
};
