/**
 * Which check-in a texting reply sets, read off the thread — shared by the
 * server, which schedules it as the reply lands, and the chat page, which shows
 * the note under a reply it just streamed without waiting for a reload. See
 * `check-ins.ts` for the feature.
 */
import { checkInMarker, isCheckInMessage, MAX_UNANSWERED_CHECK_INS } from './check-ins';
import type { CheckInMarker } from './check-ins';
import { partsToText } from './message-parts';
import { extractPlainSpeaker } from './texting';
import type { ChatMessage } from './types/api';

/**
 * The check-in a reply's markdown source sets: its last `[later …]` text, or
 * null. Split the plain way, since the server reads the source rather than the
 * html the bubbles split.
 */
export function replyCheckIn(source: string): CheckInMarker | null {
	let found: CheckInMarker | null = null;
	for (const para of source.split(/\n\s*\n/)) {
		const trimmed = para.trim();
		if (!trimmed) continue;
		found = checkInMarker(extractPlainSpeaker(trimmed)) ?? found;
	}
	return found;
}

/** How many check-ins have fired in a row, unanswered, above `index`. */
export function unansweredCheckIns(branch: ChatMessage[], index: number): number {
	let count = 0;
	for (let i = index - 1; i >= 0; i--) {
		const m = branch[i];
		if (isCheckInMessage(m)) count++;
		else if (m.role === 'user') break;
	}
	return count;
}

/** The check-in the reply `replyId` on `branch` sets — null when it has no
 *  marker, isn't on the branch, or would be one check-in too many in a row. */
export function checkInSetBy(branch: ChatMessage[], replyId: string): CheckInMarker | null {
	const index = branch.findIndex((m) => m.id === replyId);
	if (index === -1 || branch[index].role !== 'assistant') return null;
	const marker = replyCheckIn(partsToText(branch[index].parts));
	if (!marker || unansweredCheckIns(branch, index) >= MAX_UNANSWERED_CHECK_INS) return null;
	return marker;
}
