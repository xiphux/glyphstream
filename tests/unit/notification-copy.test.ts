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

	it('promotes the status line to the heading when the title was withheld', () => {
		// Never the app name: every platform already attributes the notification
		// to the app, so an app-name heading reads "GlyphStream from GlyphStream"
		// and demotes the only informative line to small text.
		expect(notificationTitle(opaque({ modality: 'video' }))).toBe('Video ready');
	});

	it("reads the server's opted-out placeholder as no title at all", () => {
		expect(
			notificationTitle(opaque({ conversationTitle: GENERIC_TITLE, summary: '12 videos ready' })),
		).toBe('12 videos ready');
	});

	it('treats an empty title as withheld, not as a blank heading', () => {
		expect(notificationTitle(opaque({ conversationTitle: '', modality: 'image' }))).toBe(
			'Image ready',
		);
	});
});

/** A payload for a user who has opted IN: the server sends the real title, so
 *  the body carries the status line under it. */
function titled(overrides: Partial<NotifyPushPayload> = {}): NotifyPushPayload {
	return opaque({ conversationTitle: 'About cats', ...overrides });
}

describe('notificationBody', () => {
	it('prefers a fan-out summary over everything', () => {
		expect(notificationBody(titled({ summary: '3 images ready', preview: 'hi' }))).toBe(
			'3 images ready',
		);
	});

	it('uses the preview when one was sent and there is no summary', () => {
		expect(notificationBody(titled({ preview: 'Cats are mysterious.' }))).toBe(
			'Cats are mysterious.',
		);
	});

	it('falls back to a modality line per kind', () => {
		expect(notificationBody(titled({ modality: 'video' }))).toBe('Video ready');
		expect(notificationBody(titled({ modality: 'image' }))).toBe('Image ready');
		expect(notificationBody(titled({ modality: 'chat' }))).toBe('New message');
	});

	it('is empty for a content-free payload, whose status line is the heading', () => {
		// Not a duplicate of the heading and not the app name: the platform's own
		// app attribution is the second GlyphStream in "GlyphStream from
		// GlyphStream", and only our half is ours to drop.
		expect(notificationBody(opaque({ modality: 'video' }))).toBeUndefined();
		expect(notificationBody(opaque({ conversationTitle: GENERIC_TITLE }))).toBeUndefined();
	});

	it('reveals nothing about the thread for a content-free payload', () => {
		// The whole point of the opt-out: heading + body together must name
		// neither the conversation nor anything in it.
		const p = opaque({ conversationTitle: GENERIC_TITLE, modality: 'video' });
		expect([notificationTitle(p), notificationBody(p)]).toEqual(['Video ready', undefined]);
	});
});
