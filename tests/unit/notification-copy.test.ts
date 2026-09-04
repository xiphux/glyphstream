import { describe, expect, it } from 'vitest';
import { GENERIC_TITLE, notificationBody, notificationTitle } from '$lib/sw/notification-copy';
import type { NotifyPushPayload } from '$lib/types/push';

/** A payload as the server builds it for a user who has opted OUT of content:
 *  no conversationTitle, no preview. */
function opaque(overrides: Partial<NotifyPushPayload> = {}): NotifyPushPayload {
	return {
		type: 'message_complete',
		conversationId: 'conv1',
		assistantMessageId: 'msg1',
		modality: 'chat',
		foregroundToast: true,
		...overrides,
	};
}

describe('notificationTitle', () => {
	it('uses the thread title when the payload carries one', () => {
		expect(notificationTitle(opaque({ conversationTitle: 'About cats' }))).toBe('About cats');
	});

	it('falls back to the app name when the title was withheld', () => {
		expect(notificationTitle(opaque())).toBe(GENERIC_TITLE);
	});
});

describe('notificationBody', () => {
	it('prefers a fan-out summary over everything', () => {
		expect(notificationBody(opaque({ summary: '3 images ready', preview: 'hi' }))).toBe(
			'3 images ready',
		);
	});

	it('uses the preview when one was sent and there is no summary', () => {
		expect(notificationBody(opaque({ preview: 'Cats are mysterious.' }))).toBe(
			'Cats are mysterious.',
		);
	});

	it('falls back to a modality line per kind', () => {
		expect(notificationBody(opaque({ modality: 'video' }))).toBe('Video ready');
		expect(notificationBody(opaque({ modality: 'image' }))).toBe('Image ready');
		expect(notificationBody(opaque({ modality: 'chat' }))).toBe('New message');
	});

	it('reveals nothing about the thread for a content-free payload', () => {
		// The whole point of the opt-out: heading + body together must name
		// neither the conversation nor anything in it.
		const p = opaque({ modality: 'video' });
		expect(`${notificationTitle(p)} ${notificationBody(p)}`).toBe('GlyphStream Video ready');
	});
});
