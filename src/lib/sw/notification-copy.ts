/**
 * Pure copy resolution for a notify payload: what heading and what body
 * line to render, given that a payload may or may not carry content.
 *
 * `conversationTitle` and `preview` are both conversation content and are
 * omitted server-side when the user has "Show message preview" off (see
 * server/push/notify.ts). The title is the sharper of the two: a fresh
 * thread's title is the user's own first message verbatim, so a media
 * generation's OS notification used to read the prompt back on the lock
 * screen. With them absent, both the OS notification and the in-app toast
 * fall back to a generic app heading and a modality line — enough to know
 * something finished and what kind of thing it was, and nothing about which
 * thread it belongs to or what it says.
 *
 * Shared by the SW (registration.showNotification) and +layout.svelte (the
 * in-app toast) so the two can't drift into disagreeing about what a
 * content-free payload looks like.
 */

import type { NotifyPushPayload } from '$lib/types/push';

/** App-level heading used when the payload carries no title. */
export const GENERIC_TITLE = 'GlyphStream';

/**
 * Heading: the thread's title when the user has opted into content,
 * otherwise the app name.
 */
export function notificationTitle(payload: NotifyPushPayload): string {
	// `||`, not `??`: an empty string is as unusable as a missing one here, and
	// the relays only coerce a NULL title to a placeholder — an empty one reaches
	// the payload intact and would render a blank heading.
	return payload.conversationTitle || GENERIC_TITLE;
}

/**
 * Body, in precedence order:
 *  1. A fan-out's count summary ("3 images ready") — non-content, always sent.
 *  2. The message preview — present only when content is shown.
 *  3. A generic modality line. Modality is not content (the summary in (1)
 *     already ships it regardless of the opt-out), so naming it is a free
 *     hint that the video you queued is the thing that just landed.
 */
export function notificationBody(payload: NotifyPushPayload): string {
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
