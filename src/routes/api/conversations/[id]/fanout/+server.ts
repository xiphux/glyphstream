/**
 * DELETE /api/conversations/:id/fanout
 *
 * Take down a parked comparison that has nothing to resolve.
 *
 * Every other way out of a fan-out grid resolves it by CHOOSING: `selectBranch`
 * (a pick, or a dismiss onto the first real result) or `../avatar/pick`. That
 * leaves no exit for a grid where every branch failed — those persist durable
 * error siblings, so the grid rebuilds from server truth on every reload, while
 * "Use this avatar" refuses a message with no image, Discard refuses to remove
 * the last column, and Done finds no successful branch to select. The marker
 * then sits parked, and the guards that read it (a background avatar draw,
 * compaction) keep refusing against a comparison the user cannot dismiss.
 *
 * So: clear the marker, move nothing. Deliberately NOT `selectBranch` on the
 * anchor — that walks to the deepest descendant, which on an all-failed grid is
 * the newest error sibling, and would put a failure into the thread as the price
 * of leaving.
 *
 * The messages stay where they are; only the "there is an unresolved comparison
 * here" flag goes. Note what that does NOT mean: the anchor stays the active
 * leaf, so anything the branches persisted are children of the leaf and fall
 * off the active branch — `walkActiveBranch` walks UP from the leaf, so no
 * message renders with them as siblings and no ‹N/M› arrow reaches them. For
 * the case this exists for that is exactly right (they are failures, carrying no
 * media), but it is a one-way door, which is why the caller only takes it when
 * there is genuinely nothing to promote instead.
 */

import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import { clearFanoutParent } from '$lib/server/db/queries/conversations';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = ({ locals, params }) => {
	requireUser(locals);
	// Scoped by user id, so a guessed conversation id clears nothing of anyone
	// else's. No 404 for a conversation that isn't ours or has no marker: this is
	// idempotent by nature — "no parked fan-out here" is the state it exists to
	// reach, and reporting that as an error would only invite a retry loop.
	clearFanoutParent(params.id, locals.user.id);
	return json({ ok: true });
};
