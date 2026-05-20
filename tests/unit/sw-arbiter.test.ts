import { describe, expect, it } from 'vitest';
import { isOnConversation, pickAction, type ArbiterClient } from '$lib/sw/arbiter';

function client(url: string, visibilityState: ArbiterClient['visibilityState'] = 'visible'): ArbiterClient {
	return { url, visibilityState };
}

const PAYLOAD = { conversationId: 'conv-1', foregroundToast: true };

describe('isOnConversation', () => {
	it('matches an exact /chat/{id} path', () => {
		expect(isOnConversation('https://app.example/chat/conv-1', 'conv-1')).toBe(true);
	});

	it('matches across query strings and hash fragments', () => {
		expect(isOnConversation('https://app.example/chat/conv-1?foo=bar', 'conv-1')).toBe(true);
		expect(isOnConversation('https://app.example/chat/conv-1#section', 'conv-1')).toBe(true);
	});

	it('matches with a trailing slash', () => {
		expect(isOnConversation('https://app.example/chat/conv-1/', 'conv-1')).toBe(true);
	});

	it('does not match a different conversation', () => {
		expect(isOnConversation('https://app.example/chat/conv-2', 'conv-1')).toBe(false);
	});

	it('does not match a different route entirely', () => {
		expect(isOnConversation('https://app.example/settings/preferences', 'conv-1')).toBe(false);
	});

	it('does not match a prefix of the path', () => {
		// /chat/conv-1234 should not silently match conv-1
		expect(isOnConversation('https://app.example/chat/conv-12', 'conv-1')).toBe(false);
	});

	it('returns false for malformed URLs', () => {
		expect(isOnConversation('not a url', 'conv-1')).toBe(false);
	});
});

describe('pickAction', () => {
	it('silent: same thread is open and visible', () => {
		expect(
			pickAction([client('https://x/chat/conv-1', 'visible')], PAYLOAD)
		).toBe('silent');
	});

	it('toast: a different thread is open and visible, foregroundToast=true', () => {
		expect(pickAction([client('https://x/chat/conv-2')], PAYLOAD)).toBe('toast');
	});

	it('toast: settings page open and visible (any visible client counts)', () => {
		expect(pickAction([client('https://x/settings/preferences')], PAYLOAD)).toBe('toast');
	});

	it('os: foregroundToast is off, even with a visible non-matching client', () => {
		expect(
			pickAction([client('https://x/settings/preferences')], { ...PAYLOAD, foregroundToast: false })
		).toBe('os');
	});

	it('os: no clients at all', () => {
		expect(pickAction([], PAYLOAD)).toBe('os');
	});

	it('os: clients exist but all are hidden', () => {
		expect(
			pickAction(
				[client('https://x/chat/conv-2', 'hidden'), client('https://x/chat/conv-3', 'hidden')],
				PAYLOAD
			)
		).toBe('os');
	});

	it('silent overrides toast: matching thread visible + other thread visible', () => {
		// Both windows are visible (multi-monitor / split-screen). The
		// matching thread wins — the SSE there delivered the message; no
		// need to toast the other window.
		expect(
			pickAction(
				[client('https://x/chat/conv-1', 'visible'), client('https://x/chat/conv-2', 'visible')],
				PAYLOAD
			)
		).toBe('silent');
	});

	it('silent only triggers when the matching client is visible', () => {
		// Same-thread tab exists but is hidden — fall through to toast/os.
		expect(
			pickAction(
				[client('https://x/chat/conv-1', 'hidden'), client('https://x/chat/conv-2', 'visible')],
				PAYLOAD
			)
		).toBe('toast');
		expect(
			pickAction([client('https://x/chat/conv-1', 'hidden')], PAYLOAD)
		).toBe('os');
	});

	it('os: same-thread tab hidden, no other visible client (locked phone, app backgrounded)', () => {
		expect(pickAction([client('https://x/chat/conv-1', 'hidden')], PAYLOAD)).toBe('os');
	});
});
