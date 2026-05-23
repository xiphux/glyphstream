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
import {
	getUserPreferences,
	setUserPreferences
} from '$lib/server/db/queries/user-preferences';
import type { EnterBehavior, UserPreferences } from '$lib/types/api';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals }) => {
	requireUser(locals);
	const prefs = getUserPreferences(locals.user.id);
	if (!prefs) throw error(404, 'User not found');
	return json(prefs);
};

export const PATCH: RequestHandler = async ({ locals, request }) => {
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

	const next = setUserPreferences(locals.user.id, patch);
	return json(next);
};
