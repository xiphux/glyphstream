/**
 * Fire push notifications when an assistant message completes.
 *
 * Server side, this is the single boundary between "a message was just
 * persisted" and "the user's devices should know." It leaves each device's
 * foreground/background arbitration to the service worker's `push` handler —
 * silent (same thread visible), in-app toast (other thread visible), or OS
 * notification (no visible client) — but it does make one CROSS-device call
 * the SW can't: it suppresses the push entirely when another of the user's
 * devices is actively rendering this conversation (see `presence.ts`), since
 * that device already shows the message and a per-device SW only sees its own
 * windows.
 *
 * The server also decides one more thing the SW can't: whether to *include
 * content* in the payload. When notificationsShowContent is false the
 * `preview` field is omitted entirely so the preview never traverses
 * the push service (defense-in-depth — encryption alone isn't the only
 * privacy contract; the operator's threat model may include the push
 * service itself).
 */

import type { NotifyModality, NotifyPushPayload } from '$lib/types/push';
import {
	deletePushSubscriptionsByEndpoints,
	listPushSubscriptionsForUser,
} from '../db/queries/push-subscriptions';
import { getUserPreferences } from '../db/queries/user-preferences';
import { isConversationBeingViewed } from './presence';
import { truncateEllipsis } from '$lib/text';
import { sendPushNotification, type WebPushSubscription } from './web-push';

const MAX_TITLE_CHARS = 60;
const MAX_PREVIEW_CHARS = 140;

export type { NotifyModality, NotifyPushPayload };

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
	/** A non-content summary line (e.g. a fan-out's "3 images ready") used as the
	 *  notification body in place of the message preview. Carries no message text,
	 *  so it is sent regardless of notificationsShowContent. Omit for single
	 *  sends. */
	summary?: string;
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
	return truncateEllipsis(stripped, maxChars);
}

function truncateTitle(title: string): string {
	return truncateEllipsis(title, MAX_TITLE_CHARS);
}

/**
 * Notify a user's subscribed devices that one of their conversations
 * has a new assistant message. Fire-and-forget; never throws — the
 * stream recorder calls this in a background promise.
 *
 * Behavior:
 *  - Reads user prefs; bails when notificationsEnabled is false.
 *  - Bails when another of the user's devices is actively rendering this
 *    conversation (cross-device suppression — see `presence.ts`).
 *  - Lists subscriptions; bails when none.
 *  - Builds payload (omits preview unless notificationsShowContent).
 *  - Sends to each subscription in parallel.
 *  - Deletes any subscription that returns 404/410 (push service says
 *    the endpoint is gone).
 */
export async function notifyConversationComplete(
	input: NotifyConversationCompleteInput,
): Promise<void> {
	const prefs = getUserPreferences(input.userId);
	if (!prefs || !prefs.notificationsEnabled) return;

	// Cross-device suppression: if any of the user's devices is actively
	// rendering this conversation (streaming its turn / fan-out, or polling a
	// recovered in-flight one), that device already shows the message in place,
	// so a push would only double-buzz a second device (the phone while you
	// watch the response finish on desktop). The per-device SW arbiter can't see
	// across devices — this is the only layer that can. Cheaper than the subs
	// query below, so short-circuit before it.
	if (isConversationBeingViewed(input.userId, input.conversationId)) return;

	const subs = listPushSubscriptionsForUser(input.userId);
	if (subs.length === 0) return;

	const payload: NotifyPushPayload = {
		type: 'message_complete',
		conversationId: input.conversationId,
		assistantMessageId: input.assistantMessageId,
		conversationTitle: truncateTitle(input.conversationTitle),
		modality: input.modality,
		foregroundToast: prefs.notificationsForegroundToast,
	};
	// A fan-out summary ("3 images ready") is a count, not message content, so it
	// ships regardless of the show-content opt-out and serves as the body.
	if (input.summary) payload.summary = input.summary;
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
				keys: { p256dh: sub.p256dh, auth: sub.auth },
			};
			const result = await sendPushNotification(webSub, payloadJson);
			if (!result.ok) {
				if (result.statusCode === 404 || result.statusCode === 410) {
					stale.push(sub.endpoint);
				} else if (result.statusCode !== undefined) {
					console.warn(`[push] send failed status=${result.statusCode} endpoint=${sub.endpoint}`);
				}
			}
		}),
	);

	if (stale.length > 0) deletePushSubscriptionsByEndpoints(stale);
}
