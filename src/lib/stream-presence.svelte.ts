/**
 * The conversation THIS client is actively generating/rendering a response for
 * right now — a single turn, a fan-out, an approval-resume, or a
 * server-recovered in-flight generation. In other words: the conversation
 * whose next completion this tab will render in place, over its own live
 * stream or recovery poll.
 *
 * Published by the chat page (from a `generating`-scoped `$effect`) and read by
 * the root layout's presence heartbeat. Cross-device push suppression must only
 * fire for a device that will actually render the completion — NOT one merely
 * parked-visible on the thread. A parked tab holds no stream and would show
 * stale content, so suppressing its other devices' notifications would silence
 * a completion nobody sees (see docs/notifications.md "Cross-device
 * suppression"). Reporting only while generating keeps the "already gets it
 * live" premise true.
 *
 * Singleton mirroring the `title-pending` / `privateView` page↔layout pattern —
 * the layout is the page's parent, so a module singleton (not context) is the
 * only way to read page-published state.
 */
class StreamPresence {
	/** The conversation this tab is currently rendering a generation for, or
	 *  null when idle. Scoped to the active conversation and cleared on thread
	 *  switch / unmount by the publishing effect. */
	conversationId = $state<string | null>(null);
}

export const streamPresence = new StreamPresence();
