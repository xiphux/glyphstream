/**
 * Server-side cleanup for a fan-out regenerate (re-roll in place): once the
 * re-roll lands, the old sibling it replaced is deleted. Doing this in the relay
 * (rather than client-side) means the swap completes even if the client
 * refreshed / suspended mid-re-roll.
 *
 * deleteBranch only stamps `hard_deleted_at` inside its transaction; unlinking
 * the now-orphaned media bytes from disk is the caller's job (the background
 * purger never sweeps `generated` media, so a missed unlink leaks the file
 * forever). This wraps both so each relay can't forget the unlink. Best-effort:
 * a leftover row/file is harmless, so failures are logged, not thrown — the
 * re-roll itself already succeeded.
 */

import { deleteBranch } from '../db/queries/messages';
import { unlinkMediaFiles } from '../media/disk-store';

export async function deleteReplacedSibling(
	conversationId: string,
	messageId: string,
	userId: string,
	label: string,
): Promise<void> {
	try {
		const res = deleteBranch(conversationId, messageId, userId);
		if (res && 'toUnlink' in res) await unlinkMediaFiles(res.toUnlink, label);
	} catch (e) {
		console.warn(`[${label}] replace-delete failed:`, e instanceof Error ? e.message : String(e));
	}
}
