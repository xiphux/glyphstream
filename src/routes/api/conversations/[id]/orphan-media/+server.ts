import { error, json } from '@sveltejs/kit';
import { countOrphanMediaInConversation } from '$lib/server/db/queries/media';
import type { RequestHandler } from './$types';

/**
 * Pre-flight count for the delete-conversation confirm dialog.
 *
 * Returns the number of generated images + videos that would orphan if
 * this conversation were deleted — i.e. media whose only references
 * are inside this conversation. The dialog uses these counts to decide
 * whether to show the "Also delete media from gallery" checkbox at
 * all (zero counts = no checkbox, dialog stays minimal for the most
 * common text-only-chat case) and to label the option informatively
 * when there is media to ask about.
 *
 * Uploaded media is intentionally excluded — it always follows the
 * purger's auto-sweep path under the library model and isn't part
 * of the user's decision.
 */
export const GET: RequestHandler = ({ locals, params }) => {
	if (!locals.user) throw error(401, 'Authentication required');
	const counts = countOrphanMediaInConversation(params.id, locals.user.id);
	return json(counts);
};
