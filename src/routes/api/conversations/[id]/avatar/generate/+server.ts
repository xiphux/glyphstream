/**
 * POST /api/conversations/:id/avatar/generate — retired.
 *
 * A portrait used to be drawn here as a message of its own, under the reply
 * describing the assistant. It's a version on that reply now, drawn through
 * POST ../../photos with `kind: 'portrait'`. A tab still running the release
 * before that would otherwise draw into a thread that no longer reads it, so it
 * is told to reload instead.
 */

import { error } from '@sveltejs/kit';
import { requireUser } from '#lib/server/auth/guard.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ locals }) => {
	requireUser(locals);
	error(409, 'Avatars draw differently now — reload the page to draw this one.');
};
