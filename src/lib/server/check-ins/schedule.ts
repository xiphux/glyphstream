/**
 * Setting a check-in from a reply that finished with a `[later …]`
 * marker (see `#lib/check-ins.ts`).
 *
 * Runs as each turn ends in a conversation that allows check-ins. Any reply that lands on the active branch
 * supersedes the conversation's previous check-in — the thread has moved past
 * the reply that set it — so the old row goes whether or not the new reply sets
 * one of its own.
 */
import { checkInSetBy } from '#lib/texting-check-ins.js';
import { deleteCheckIn, setCheckIn } from '../db/queries/check-ins';
import { walkActiveBranch } from '../db/queries/messages';
import { getCheckInsConfig } from '../endpoints/config';

/**
 * Replace the conversation's check-in with whatever `replyId` sets. Returns
 * whether it set one. The caller has already resolved the conversation as
 * `userId`'s.
 */
export function scheduleCheckInFromReply(
	conversationId: string,
	userId: string,
	replyId: string,
	now = Date.now(),
): boolean {
	deleteCheckIn(conversationId, userId);
	if (!getCheckInsConfig().enabled) return false;
	const marker = checkInSetBy(walkActiveBranch(conversationId), replyId);
	if (!marker) return false;
	setCheckIn({
		userId,
		conversationId,
		sourceMessageId: replyId,
		note: marker.note,
		fireAt: now + marker.delayMs,
		now,
	});
	return true;
}
