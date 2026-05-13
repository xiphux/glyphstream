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
import {
	getUserPreferences,
	setUserPreferences
} from '$lib/server/db/queries/user-preferences';
import type { EnterBehavior, UserPreferences } from '$lib/types/api';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals }) => {
	if (!locals.user) throw error(401, 'Authentication required');
	const prefs = getUserPreferences(locals.user.id);
	if (!prefs) throw error(404, 'User not found');
	return json(prefs);
};

export const PATCH: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) throw error(401, 'Authentication required');

	let body: Partial<UserPreferences>;
	try {
		body = (await request.json()) as Partial<UserPreferences>;
	} catch {
		throw error(400, 'Request body must be JSON');
	}

	// Build a narrowed patch object — explicitly validate each field rather
	// than passing the unsanitized body to the query, so the query layer
	// only ever sees known-good values. (The query itself is also
	// defensive, but defense-in-depth is cheap here.)
	const patch: Partial<UserPreferences> = {};
	if (typeof body.systemPrompt === 'string') {
		patch.systemPrompt = body.systemPrompt;
	}
	if (body.enterBehavior !== undefined) {
		if (body.enterBehavior !== 'send' && body.enterBehavior !== 'newline') {
			throw error(400, `Invalid enterBehavior "${body.enterBehavior as string}"`);
		}
		patch.enterBehavior = body.enterBehavior as EnterBehavior;
	}

	const next = setUserPreferences(locals.user.id, patch);
	return json(next);
};
