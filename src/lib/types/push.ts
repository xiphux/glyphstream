/**
 * Shared payload types for the notify pipeline. Used by:
 *  - src/lib/server/push/notify.ts — builds the payload, JSON-encodes it,
 *    hands it to web-push.
 *  - src/service-worker.ts — receives the push, decodes JSON, decides
 *    whether to silent/toast/show OS notification.
 *  - src/routes/+layout.svelte — receives the SW's postMessage and
 *    surfaces a toast.
 *
 * Lives under client-safe `src/lib/types/` so the SW and Svelte files
 * can import without pulling in server-only modules (web-push, drizzle).
 */

import type { ModelKind } from './api';

/**
 * The notify pipeline carries the same modality set as the rest of the
 * app — aliased (not redeclared) so a new ModelKind can't be silently
 * forgotten here.
 */
export type NotifyModality = ModelKind;

export interface NotifyPushPayload {
	type: 'message_complete';
	conversationId: string;
	assistantMessageId: string;
	conversationTitle: string;
	modality: NotifyModality;
	/** Present iff notificationsShowContent is true. Omitted entirely
	 *  (not even an empty string) when the user opted out. */
	preview?: string;
	/** A non-content summary line shown as the notification body — e.g. a
	 *  multi-model fan-out's "3 images ready". Carries no message text (just a
	 *  count + modality), so it is sent regardless of notificationsShowContent and
	 *  takes precedence over `preview` as the body. Omitted for ordinary single
	 *  sends, which use `preview`. */
	summary?: string;
	/** Whether the SW should postMessage to visible clients for an
	 *  in-app toast. False -> silent foreground + OS notification only
	 *  for backgrounded states. */
	foregroundToast: boolean;
}

/** Messages the SW posts to controlled clients. */
export type SwClientMessage =
	| { kind: 'message_complete_toast'; payload: NotifyPushPayload }
	| { kind: 'navigate_to_conversation'; conversationId: string }
	/** Sent while arbitrating a push. Carries a MessagePort (in the
	 *  event's `ports`) the client replies on with an
	 *  ActiveConversationReport. */
	| { kind: 'query_active_conversation' };

/**
 * A window's authoritative self-report of which conversation it is
 * showing and whether it is visible. The SW asks for this (via
 * `query_active_conversation`) instead of reading WindowClient.url +
 * visibilityState itself: WindowClient.url does not reliably track
 * SvelteKit client-side (pushState) navigation, so a window that has
 * SPA-navigated to /chat/{id} can still report its original load URL.
 * The page itself always knows its real route.
 */
export interface ActiveConversationReport {
	/** The conversation id the window is viewing, or null when it's on a
	 *  non-conversation page (new-chat, settings, gallery, …). */
	conversationId: string | null;
	/** document.visibilityState === 'visible' at reply time. */
	visible: boolean;
}
