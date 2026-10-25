/**
 * Whether the conversation being rendered is a scheduled task's run — set by
 * the chat page, read by the approval prompt deep in the message tree, which
 * then offers "for this schedule" choices. Context rather than a prop: the
 * prompt is five components below the page, and nothing in between cares.
 * A getter, so it tracks the page's data across navigations.
 */
import { getContext, setContext } from 'svelte';

/** Exported for component tests, which pass it in `render`'s `context`. */
export const SCHEDULED_RUN_CONTEXT_KEY = Symbol('scheduled-run');
const KEY = SCHEDULED_RUN_CONTEXT_KEY;

export function setScheduledRunContext(isScheduledRun: () => boolean): void {
	setContext(KEY, isScheduledRun);
}

/** False outside a chat page (or before one sets it). */
export function getScheduledRunContext(): () => boolean {
	return getContext<(() => boolean) | undefined>(KEY) ?? (() => false);
}
