/**
 * Fire push notifications when an assistant message completes.
 *
 * Server side, this is the single boundary between "a message was just
 * persisted" and "the user's devices should know." It's intentionally
 * unaware of foreground/background — the service worker's `push`
 * handler arbitrates between silent (same thread visible), in-app toast
 * (other thread visible), and OS notification (no visible client).
 *
 * The server still decides one thing the SW can't: whether to *include
 * content* in the payload. When notificationsShowContent is false the
 * `preview` field is omitted entirely so the preview never traverses
 * the push service (defense-in-depth — encryption alone isn't the only
 * privacy contract; the operator's threat model may include the push
 * service itself).
 */

import {
	deletePushSubscriptionsByEndpoints,
	listPushSubscriptionsForUser
} from '../db/queries/push-subscriptions';
import { getUserPreferences } from '../db/queries/user-preferences';
import { sendPushNotification, type WebPushSubscription } from './web-push';

const MAX_TITLE_CHARS = 60;
const MAX_PREVIEW_CHARS = 140;

export type NotifyModality = 'chat' | 'image' | 'video' | 'embedding';

export interface NotifyConversationCompleteInput {
	userId: string;
	conversationId: string;
	assistantMessageId: string;
	conversationTitle: string;
	/** Plain markdown source text of the assistant message; stripped and
	 *  truncated inside this function. Pass the empty string for non-text
	 *  modalities (image/video) — the preview will be empty either way. */
	previewText: string;
	modality: NotifyModality;
}

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

/**
 * Pure: convert markdown source to a short plain-text preview. Strips
 * fenced code blocks, headers, bold/italic markers, inline code, and
 * link syntax, then collapses whitespace and truncates. Good-enough
 * for a 140-char notification body, not a full markdown renderer.
 */
export function buildPreview(markdownSource: string, maxChars = MAX_PREVIEW_CHARS): string {
	const stripped = markdownSource
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/`([^`]*)`/g, '$1')
		.replace(/^#{1,6}\s+/gm, '')
		.replace(/\*\*([^*]+)\*\*/g, '$1')
		.replace(/\*([^*]+)\*/g, '$1')
		.replace(/__([^_]+)__/g, '$1')
		.replace(/_([^_]+)_/g, '$1')
		.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
		.replace(/!\[[^\]]*\]\([^)]+\)/g, '')
		.replace(/^\s*[-*+]\s+/gm, '')
		.replace(/^\s*\d+\.\s+/gm, '')
		.replace(/^\s*>\s*/gm, '')
		.replace(/\s+/g, ' ')
		.trim();
	if (stripped.length <= maxChars) return stripped;
	return stripped.slice(0, maxChars - 1).trimEnd() + '…';
}

function truncateTitle(title: string): string {
	if (title.length <= MAX_TITLE_CHARS) return title;
	return title.slice(0, MAX_TITLE_CHARS - 1).trimEnd() + '…';
}

/**
 * Notify a user's subscribed devices that one of their conversations
 * has a new assistant message. Fire-and-forget; never throws — the
 * stream recorder calls this in a background promise.
 *
 * Behavior:
 *  - Reads user prefs; bails when notificationsEnabled is false.
 *  - Lists subscriptions; bails when none.
 *  - Builds payload (omits preview unless notificationsShowContent).
 *  - Sends to each subscription in parallel.
 *  - Deletes any subscription that returns 404/410 (push service says
 *    the endpoint is gone).
 */
export async function notifyConversationComplete(
	input: NotifyConversationCompleteInput
): Promise<void> {
	const prefs = getUserPreferences(input.userId);
	if (!prefs || !prefs.notificationsEnabled) return;

	const subs = listPushSubscriptionsForUser(input.userId);
	if (subs.length === 0) return;

	const payload: NotifyPushPayload = {
		type: 'message_complete',
		conversationId: input.conversationId,
		assistantMessageId: input.assistantMessageId,
		conversationTitle: truncateTitle(input.conversationTitle),
		modality: input.modality,
		foregroundToast: prefs.notificationsForegroundToast
	};
	if (prefs.notificationsShowContent) {
		const preview = buildPreview(input.previewText);
		if (preview.length > 0) payload.preview = preview;
	}
	const payloadJson = JSON.stringify(payload);

	const stale: string[] = [];
	await Promise.allSettled(
		subs.map(async (sub) => {
			const webSub: WebPushSubscription = {
				endpoint: sub.endpoint,
				keys: { p256dh: sub.p256dh, auth: sub.auth }
			};
			const result = await sendPushNotification(webSub, payloadJson);
			if (!result.ok) {
				if (result.statusCode === 404 || result.statusCode === 410) {
					stale.push(sub.endpoint);
				} else if (result.statusCode !== undefined) {
					console.warn(
						`[push] send failed status=${result.statusCode} endpoint=${sub.endpoint}`
					);
				}
			}
		})
	);

	if (stale.length > 0) deletePushSubscriptionsByEndpoints(stale);
}
