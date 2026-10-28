/**
 * POST /api/conversations/:id/avatar/pick — retired, with ../generate (see
 * there). A portrait is picked by putting its version on show
 * (PATCH ../../photos/:photoId), which also makes it the face.
 */

import { error } from '@sveltejs/kit';
import { requireUser } from '#lib/server/auth/guard.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ locals }) => {
	requireUser(locals);
	error(409, 'Avatars draw differently now — reload the page to pick one.');
};
