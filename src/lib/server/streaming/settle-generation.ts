/**
 * What a relay does once a generation's result is persisted and `done` sent:
 * give the endpoint back, stop reporting the conversation as generating, and
 * then wait a bounded time for the conversation's title.
 *
 * The order is the point, and it is the same for chat and media:
 *
 * 1. Release the endpoint slot BEFORE the title race. This is required, not an
 *    optimisation: the title task acquires the same endpoint gate (see
 *    callTaskModel), so on a single-GPU (`max_concurrent = 1`) endpoint that
 *    also serves the task model, holding the slot across the race would keep
 *    the title task from ever being granted. The race would burn its whole
 *    budget while the next queued generation waited it out.
 * 2. Settle the in-flight entry at the same boundary, so nothing asking "is
 *    this conversation generating?" gets a stale yes for the length of the
 *    race. The callers' settle is identity-guarded, so their `finally`
 *    clean-up stays a harmless no-op and can't clobber a fast follow-up turn's
 *    entry.
 * 3. Race the title, and send it if it arrives in time.
 *
 * The budget is the caller's: chat has already settled its UI and can wait
 * long; media keeps its stream open for it, so it waits briefly.
 */
import type { StreamTitleEvent } from '#lib/types/api.js';
import { raceTitle } from '../tasks/title-task-runner';

export async function settleGeneration(args: {
	/** Free the endpoint slot. Idempotent; the caller's `finally` calls it too. */
	releaseSlot: () => void;
	/** Mark the generation over in the in-flight registry. */
	onSettled?: () => void;
	/** The conversation's title task, or null when none was started. */
	titlePromise: Promise<string | null> | null;
	titleBudgetMs: number;
	writeTitle: (event: StreamTitleEvent) => void;
}): Promise<void> {
	args.releaseSlot();
	args.onSettled?.();
	if (!args.titlePromise) return;
	const title = await raceTitle(args.titlePromise, args.titleBudgetMs);
	if (title) args.writeTitle({ type: 'title', title });
}
