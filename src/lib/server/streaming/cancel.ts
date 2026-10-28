/**
 * Stopping a conversation's in-flight generation(s), shared by the Stop button
 * (POST /cancel) and conversation delete.
 *
 * A plain send has one in-flight entry; a multi-model fan-out has N (one per
 * branch). Every entry's AbortController is aborted, and any video branch also
 * gets a bridge-side DELETE /v1/videos/{id} so the runner releases its slot
 * instead of finishing the workflow.
 *
 * For chat / image the abort makes the upstream fetch error; the recorder branch
 * (chat) commits whatever partial text it had.
 */
import { videoCancel } from '../endpoints/client';
import { getInFlightEntries, PHOTO_BRANCH_PREFIX, type InFlightEntry } from './in-flight';

/** Whether an entry is a texting photo's draw (see `register` in the job runner). */
export function isPhotoDraw(entry: InFlightEntry): boolean {
	return entry.branchKey.startsWith(PHOTO_BRANCH_PREFIX);
}

/**
 * Cancel the conversation's generations. Resolves `false` when nothing was in
 * flight (the user clicked Stop too late, or the stream already ended). Callers
 * must have checked ownership: this acts on the id alone.
 *
 * `sparePhotos` leaves texting photos drawing: the Stop button stops the reply
 * on screen, and a photo of an earlier reply isn't it. Deleting the
 * conversation stops everything.
 */
export async function cancelInFlightGenerations(
	conversationId: string,
	opts: { sparePhotos?: boolean } = {},
): Promise<boolean> {
	const entries = getInFlightEntries(conversationId).filter(
		(e) => !opts.sparePhotos || !isPhotoDraw(e),
	);
	if (entries.length === 0) return false;

	// Every local abort first, synchronously: they stop the upstream fetch and
	// the recorder at once, so nothing keeps streaming (or holding its endpoint
	// slot) while a bridge cancel below waits out its timeout. Conversation
	// delete relies on this, since it doesn't await the call.
	for (const entry of entries) entry.controller.abort();

	// Then the best-effort bridge-side cancels, releasing the runners' slots. In
	// parallel: videoCancel has a 10s timeout (and swallows its own errors), so a
	// serial loop over a multi-branch video fan-out could stall for N×10s against
	// an unresponsive bridge. Promise.all bounds it to a single worst-case timeout.
	await Promise.all(
		entries.flatMap((entry) =>
			entry.videoJobId ? [videoCancel(entry.endpoint, entry.videoJobId)] : [],
		),
	);
	return true;
}
