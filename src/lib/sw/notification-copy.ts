/**
 * Pure copy resolution for a notify payload: what heading and what body
 * line to render, given that a payload may or may not carry content.
 *
 * `conversationTitle` and `preview` are both conversation content, and the
 * server withholds both when the user has "Show message preview" off (see
 * server/push/notify.ts) — but by different means: `preview` is omitted, while
 * `conversationTitle` is REPLACED by GENERIC_TITLE. The title is the sharper of
 * the two: a fresh thread's title is the user's own first message verbatim, so
 * a media generation's OS notification used to read the prompt back on the lock
 * screen. Either way the user learns that something finished and what kind of
 * thing it was, and nothing about which thread it belongs to or what it says.
 *
 * A content-free payload has no heading of its own, so the modality/count line
 * is promoted to the heading and the body is dropped rather than rendering the
 * app's name over it. Every platform that shows a web notification already
 * attributes it to the app — Android and iOS in the header, desktop Chrome and
 * Safari in a trailing source line — so an app-name heading reads as
 * "GlyphStream from GlyphStream" with the one line that carries information
 * demoted to small text under it. Promoting it costs nothing: the heading is
 * the bold line on a locked phone, and "12 videos ready" is exactly what the
 * opted-out user is allowed to be told.
 *
 * That makes GENERIC_TITLE a sentinel here and not a fallback: the server sends
 * it in place of a withheld title, and this module reads it back as "there is
 * no title". A thread genuinely titled "GlyphStream" therefore renders like an
 * opted-out one — a cosmetic no-op, and the only way to avoid it would be a
 * second payload field saying what this one already says.
 *
 * Shared by the SW (registration.showNotification) and +layout.svelte (the
 * in-app toast) so the two can't drift into disagreeing about what a
 * content-free payload looks like.
 */

import type { NotifyPushPayload } from '$lib/types/push';

/** Stands in for the thread title in a payload built for a user who opted out
 *  of content. Sent by the server (rather than dropping the field) for the
 *  benefit of service workers cached from before that gate existed; read back
 *  here as the absence of a title. */
export const GENERIC_TITLE = 'GlyphStream';

/**
 * Whether the payload carries the thread's real title — i.e. whether the user
 * has opted into content.
 *
 * `||`-style falsiness, not `??`: an empty string is as unusable as a missing
 * one here, and the relays only coerce a NULL title to a placeholder — an empty
 * one reaches the payload intact and would render a blank heading.
 */
function hasThreadTitle(
	payload: NotifyPushPayload,
): payload is NotifyPushPayload & { conversationTitle: string } {
	return Boolean(payload.conversationTitle) && payload.conversationTitle !== GENERIC_TITLE;
}

/**
 * The one line every payload can show: a fan-out's count summary ("3 images
 * ready") if it has one, else the preview (present only when content is shown),
 * else a generic modality line. Modality is not content — the summary in the
 * first branch already ships it regardless of the opt-out — so naming it is a
 * free hint that the video you queued is the thing that just landed.
 */
function statusLine(payload: NotifyPushPayload): string {
	if (payload.summary) return payload.summary;
	if (payload.preview) return payload.preview;
	switch (payload.modality) {
		case 'image':
			return 'Image ready';
		case 'video':
			return 'Video ready';
		default:
			return 'New message';
	}
}

/**
 * Heading: the thread's title when the user has opted into content,
 * otherwise the status line (which the body then omits).
 */
export function notificationTitle(payload: NotifyPushPayload): string {
	return hasThreadTitle(payload) ? payload.conversationTitle : statusLine(payload);
}

/**
 * Body: the status line under the thread's title — or nothing at all for a
 * content-free payload, whose status line is already the heading.
 */
export function notificationBody(payload: NotifyPushPayload): string | undefined {
	return hasThreadTitle(payload) ? statusLine(payload) : undefined;
}
