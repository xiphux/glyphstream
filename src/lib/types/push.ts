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

export type NotifyModality = 'chat' | 'image' | 'video' | 'embedding';

export interface NotifyPushPayload {
	type: 'message_complete';
	conversationId: string;
	assistantMessageId: string;
	conversationTitle: string;
	modality: NotifyModality;
	/** Present iff notificationsShowContent is true. Omitted entirely
	 *  (not even an empty string) when the user opted out. */
	preview?: string;
	/** Whether the SW should postMessage to visible clients for an
	 *  in-app toast. False -> silent foreground + OS notification only
	 *  for backgrounded states. */
	foregroundToast: boolean;
}

/** Messages the SW posts to controlled clients. */
export type SwClientMessage =
	| { kind: 'message_complete_toast'; payload: NotifyPushPayload }
	| { kind: 'navigate_to_conversation'; conversationId: string };
