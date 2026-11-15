/**
 * POST /api/conversations/:id/avatar/generate — retired.
 *
 * A portrait is a version on the reply describing the assistant, drawn through
 * POST ../../photos with `kind: 'portrait'`. A tab still running a release that
 * drew it here, as a message of its own, would draw into a thread that no
 * longer reads it, so it is told to reload instead.
 */

import { error } from '@sveltejs/kit';
import { requireUser } from '#lib/server/auth/guard.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ locals }) => {
	requireUser(locals);
	error(409, 'Avatars draw differently now — reload the page to draw this one.');
};
