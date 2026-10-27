/**
 * Setting a check-in from a reply that finished with a `[later …]`
 * marker (see `#lib/check-ins.ts`).
 *
 * Runs as each turn ends in a conversation that allows check-ins. Any reply that lands on the active branch
 * supersedes the conversation's previous check-in — the thread has moved past
 * the reply that set it — so the old row goes whether or not the new reply sets
 * one of its own.
 */
import { partsToText } from '#lib/message-parts.js';
import { checkInSetBy, replyCheckIn } from '#lib/texting-check-ins.js';
import type { ChatMessage } from '#lib/types/api.js';
import { deleteCheckIn, setCheckIn } from '../db/queries/check-ins';
import { walkActiveBranch } from '../db/queries/messages';
import { getCheckInsConfig } from '../endpoints/config';

/**
 * Replace the conversation's check-in with whatever `reply` sets. Returns
 * whether it set one. The caller has already resolved the conversation as
 * `userId`'s.
 *
 * Runs before every such turn's `done`, so the common case — no marker — must
 * stay cheap: one keyed DELETE, and the branch is only walked (for the unanswered-in-a-row cap)
 * when the reply's own text has one, and then without the render columns.
 */
export function scheduleCheckInFromReply(
	conversationId: string,
	userId: string,
	reply: Pick<ChatMessage, 'id' | 'parts'>,
	now = Date.now(),
): boolean {
	deleteCheckIn(conversationId, userId);
	if (!getCheckInsConfig().enabled) return false;
	if (!replyCheckIn(partsToText(reply.parts))) return false;
	const branch = walkActiveBranch(conversationId, { columns: 'serialization' });
	const marker = checkInSetBy(branch, reply.id);
	if (!marker) return false;
	setCheckIn({
		userId,
		conversationId,
		sourceMessageId: reply.id,
		note: marker.note,
		fireAt: now + marker.delayMs,
		now,
	});
	return true;
}
