/**
 * POST /api/conversations/:id/avatar/prepare — retired, with ../generate (see
 * there). An avatar comparison no longer parks the thread: it's several
 * portrait draws onto the description, picked from like a photo comparison.
 */

import { error } from '@sveltejs/kit';
import { requireUser } from '#lib/server/auth/guard.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ locals }) => {
	requireUser(locals);
	error(409, 'Avatars draw differently now — reload the page to draw this one.');
};
