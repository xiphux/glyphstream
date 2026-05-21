import { describe, expect, it } from 'vitest';
import { pickAction } from '$lib/sw/arbiter';
import type { ActiveConversationReport } from '$lib/types/push';

function report(conversationId: string | null, visible = true): ActiveConversationReport {
	return { conversationId, visible };
}

const PAYLOAD = { conversationId: 'conv-1', foregroundToast: true };

describe('pickAction', () => {
	it('silent: the matching conversation is reported visible', () => {
		expect(pickAction([report('conv-1', true)], PAYLOAD)).toBe('silent');
	});

	it('toast: a different conversation is reported visible', () => {
		expect(pickAction([report('conv-2', true)], PAYLOAD)).toBe('toast');
	});

	it('toast: a non-conversation page is reported visible (conversationId null)', () => {
		// e.g. the settings or new-chat page — any visible window counts.
		expect(pickAction([report(null, true)], PAYLOAD)).toBe('toast');
	});

	it('os: foregroundToast is off, even with a visible non-matching window', () => {
		expect(pickAction([report(null, true)], { ...PAYLOAD, foregroundToast: false })).toBe('os');
	});

	it('os: no reports at all (app closed, or no window answered the query)', () => {
		expect(pickAction([], PAYLOAD)).toBe('os');
	});

	it('os: windows reported, but all hidden', () => {
		expect(
			pickAction([report('conv-2', false), report('conv-3', false)], PAYLOAD)
		).toBe('os');
	});

	it('silent overrides toast: matching window visible + another window visible', () => {
		// Multi-monitor / split-screen: both windows visible. The matching
		// thread wins — the SSE there delivered the message; no toast needed.
		expect(
			pickAction([report('conv-1', true), report('conv-2', true)], PAYLOAD)
		).toBe('silent');
	});

	it('silent only triggers when the matching window is visible', () => {
		// Matching conversation exists but is hidden — fall through to toast/os.
		expect(
			pickAction([report('conv-1', false), report('conv-2', true)], PAYLOAD)
		).toBe('toast');
		expect(pickAction([report('conv-1', false)], PAYLOAD)).toBe('os');
	});

	it('os: matching conversation reported hidden, nothing else visible (locked phone)', () => {
		expect(pickAction([report('conv-1', false)], PAYLOAD)).toBe('os');
	});
});
