/**
 * When does looking at a conversation count as acknowledging its
 * notification?
 *
 * Seeing a thread is the acknowledgment the notification was asking for, so
 * arriving on one retracts its tray entry and re-derives the app-icon badge
 * (see `dismissConversationNotifications`). Two things make that harder than
 * "the page is open":
 *
 * 1. **Being visible is required.** A backgrounded desktop tab parked on a
 *    conversation is exactly the case the SW arbiter raises an OS notification
 *    for (`pickAction`: same thread, not visible -> 'os'). Acknowledging from a
 *    hidden window would retract the notification we just showed.
 *
 * 2. **Being focused on the way somewhere else is not a visit.** Tapping thread
 *    A's notification focuses a window still parked on thread B, and that focus
 *    is what flips visibility — so an unguarded acknowledgment would dismiss B
 *    for a user who only asked to see A, destroying a completion signal they
 *    never saw. Hence `pendingConversationId`.
 *
 * The pending id is *compared*, not merely tested for existence. "A navigation
 * is in flight, so skip" looks equivalent and is not: SvelteKit clears
 * `navigating` only after flushing effects, so the effect that runs when thread
 * A finally arrives still sees a pending navigation to A. Skipping there would
 * mark A acknowledged (the sentinel is already set) without ever dismissing it,
 * stranding its notification permanently.
 *
 * Extracted from the chat page so the decision — and the deferral below, whose
 * whole reason for existing is an event ordering we can't reproduce in CI — is
 * exercised by `tests/unit/notification-ack.test.ts` rather than by reasoning
 * about iOS. Same split the push arbiter uses: a decision that's testable in
 * isolation, and thin glue in the component that can't be.
 *
 * Plain `.ts`, not `.svelte.ts`: nothing here is reactive state, and one
 * instance belongs to one page component (never a module singleton — that
 * would publish one user's state into another's SSR render).
 */

/**
 * How long the visibility path waits before acknowledging.
 *
 * The pending-navigation check only means anything once the navigation has
 * actually started. On Chromium it has by then: the SW queues
 * `navigate_to_conversation` before `focus()` flips visibility, so `navigating`
 * is set by the time we look. On an iOS standalone PWA the OS foregrounds the
 * app and `notificationclick` may not have posted yet — checking inline would
 * see no pending navigation and acknowledge whichever thread the window
 * happened to be parked on, reinstating the bug on the one platform this
 * feature is for. Task sources aren't ordered against each other by spec, so
 * the Chromium ordering is convention rather than guarantee either way.
 *
 * A beat is enough for the message to land and start its navigation. The delay
 * is invisible: nothing on screen depends on it, only the notification tray.
 */
export const ACK_DEFER_MS = 150;

export interface NotificationAckDeps {
	/** The conversation this window is currently showing. */
	conversationId(): string;
	/** Whether the window is visible right now (`document.visibilityState`). */
	visible(): boolean;
	/**
	 * The conversation a navigation is currently heading to, or undefined when
	 * no navigation is in flight (or it targets a non-conversation route).
	 */
	pendingConversationId(): string | undefined;
	/** Retract this conversation's notifications and re-derive the badge. */
	dismiss(conversationId: string): void;
}

export class NotificationAck {
	#deps: NotificationAckDeps;
	/**
	 * The last conversation `conversationChanged()` acted on. Starts null
	 * rather than at the current id so the first call isn't skipped — arriving
	 * by full page load is exactly what tapping a notification does when no
	 * window is open, and that has to count as a visit.
	 */
	#acknowledged: string | null = null;
	#timer: ReturnType<typeof setTimeout> | null = null;

	constructor(deps: NotificationAckDeps) {
		this.#deps = deps;
	}

	/**
	 * The page's conversation may have changed — mount, or navigation to
	 * another thread. Acknowledges immediately: by the time a conversation is
	 * current there is no ordering left to wait on.
	 *
	 * Cheap to over-call. The page drives this from an effect that re-runs on
	 * any invalidation, and the sentinel makes every repeat a string compare
	 * rather than a tray query.
	 */
	conversationChanged(): void {
		const id = this.#deps.conversationId();
		if (id === this.#acknowledged) return;
		this.#acknowledged = id;
		this.#acknowledge(id);
	}

	/**
	 * The window became visible. Deferred by `ACK_DEFER_MS`; a second call
	 * before the timer fires replaces it rather than stacking, so rapid
	 * focus/blur cycling costs one acknowledgment, not one per flip.
	 *
	 * Safe to defer because the conversation id and visibility are both re-read
	 * when the timer fires: a navigation that completed in the meantime
	 * acknowledges the thread we actually ended up on, and a window that went
	 * hidden again acknowledges nothing.
	 */
	becameVisible(): void {
		if (this.#timer !== null) clearTimeout(this.#timer);
		this.#timer = setTimeout(() => {
			this.#timer = null;
			this.#acknowledge(this.#deps.conversationId());
		}, ACK_DEFER_MS);
	}

	/** Drop a pending acknowledgment so it can't fire against a torn-down page. */
	destroy(): void {
		if (this.#timer !== null) clearTimeout(this.#timer);
		this.#timer = null;
	}

	#acknowledge(conversationId: string): void {
		if (!this.#deps.visible()) return;
		const pending = this.#deps.pendingConversationId();
		if (pending !== undefined && pending !== conversationId) return;
		this.#deps.dismiss(conversationId);
	}
}
