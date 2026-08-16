import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACK_DEFER_MS, NotificationAck } from '$lib/notification-ack';

/**
 * The interesting cases here are the ones CI can't reach any other way: the
 * orderings of "the SW says navigate" and "the window became visible". We
 * can't learn which one iOS produces — but we can pin down that the outcome is
 * the same either way, which is what makes the question moot.
 */

/** A page whose visibility, current thread and pending navigation are settable. */
function harness(initial: { conversationId: string; visible?: boolean; pending?: string }) {
	const state = {
		conversationId: initial.conversationId,
		visible: initial.visible ?? true,
		pending: initial.pending,
	};
	const dismiss = vi.fn<(conversationId: string) => void>();
	const ack = new NotificationAck({
		conversationId: () => state.conversationId,
		visible: () => state.visible,
		pendingConversationId: () => state.pending,
		dismiss,
	});
	return { ack, dismiss, state };
}

/**
 * A page that mounted a while ago and has settled on a thread — the state a
 * running app is in before it gets backgrounded. Distinct from a fresh
 * `harness`, where mount itself is still ahead of us.
 */
function parkedOn(conversationId: string) {
	const h = harness({ conversationId });
	h.ack.conversationChanged();
	vi.advanceTimersByTime(ACK_DEFER_MS);
	h.dismiss.mockClear();
	return h;
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('conversationChanged', () => {
	it('acknowledges on mount, deferred', () => {
		// Mount has to count as a visit — arriving by full page load is exactly
		// what tapping a notification does when no window is open. It defers
		// because "the conversation is current" can also mean "this is where
		// the app happened to be parked"; see the cold-launch case below.
		const { ack, dismiss } = harness({ conversationId: 'a' });
		ack.conversationChanged();
		expect(dismiss).not.toHaveBeenCalled();
		vi.advanceTimersByTime(ACK_DEFER_MS);
		expect(dismiss).toHaveBeenCalledWith('a');
	});

	it('is a no-op when the conversation has not actually changed', () => {
		// The page drives this from an effect that re-runs on every
		// invalidation — i.e. after every completed turn.
		const { ack, dismiss, state } = parkedOn('a');
		state.conversationId = 'a';
		ack.conversationChanged();
		ack.conversationChanged();
		vi.advanceTimersByTime(ACK_DEFER_MS);
		expect(dismiss).not.toHaveBeenCalled();
	});

	it('acknowledges a genuine conversation change immediately, not deferred', () => {
		// A navigation needs no wait: the thread is current *because* the user
		// went there, so there is no ordering left to resolve.
		const { ack, dismiss, state } = parkedOn('a');
		state.conversationId = 'b';
		ack.conversationChanged();
		expect(dismiss).toHaveBeenCalledWith('b');
	});

	it('acknowledges the thread we are arriving at, not despite arriving at it', () => {
		// SvelteKit clears `navigating` only after flushing effects, so the
		// effect that runs when 'b' arrives still sees a pending navigation to
		// 'b'. Testing "is a navigation in flight" instead of comparing ids
		// would skip here — and the sentinel is already set, so nothing would
		// ever retry. That strands b's notification permanently.
		const { ack, dismiss, state } = parkedOn('a');
		state.conversationId = 'b';
		state.pending = 'b';
		ack.conversationChanged();
		expect(dismiss).toHaveBeenCalledWith('b');
	});

	it('does not acknowledge from a hidden window', () => {
		// A backgrounded tab parked on this thread is exactly what the arbiter
		// raised the notification for; dismissing here retracts it unseen.
		const { ack, dismiss } = harness({ conversationId: 'a', visible: false });
		ack.conversationChanged();
		vi.advanceTimersByTime(ACK_DEFER_MS);
		expect(dismiss).not.toHaveBeenCalled();
	});
});

describe('becameVisible', () => {
	it('acknowledges after the defer window, not before', () => {
		const { ack, dismiss } = parkedOn('a');
		ack.becameVisible();
		vi.advanceTimersByTime(ACK_DEFER_MS - 1);
		expect(dismiss).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(dismiss).toHaveBeenCalledWith('a');
	});

	it('collapses rapid focus/blur cycling into one acknowledgment', () => {
		const { ack, dismiss } = parkedOn('a');
		ack.becameVisible();
		vi.advanceTimersByTime(ACK_DEFER_MS / 2);
		ack.becameVisible();
		vi.advanceTimersByTime(ACK_DEFER_MS / 2);
		ack.becameVisible();
		vi.advanceTimersByTime(ACK_DEFER_MS);
		expect(dismiss).toHaveBeenCalledTimes(1);
	});

	it('acknowledges nothing if the window went hidden again before firing', () => {
		const { ack, dismiss, state } = parkedOn('a');
		ack.becameVisible();
		state.visible = false;
		vi.advanceTimersByTime(ACK_DEFER_MS);
		expect(dismiss).not.toHaveBeenCalled();
	});

	it('does not fire after destroy', () => {
		const { ack, dismiss } = parkedOn('a');
		ack.becameVisible();
		ack.destroy();
		vi.advanceTimersByTime(ACK_DEFER_MS);
		expect(dismiss).not.toHaveBeenCalled();
	});
});

describe('tapping thread A while the window is parked on thread B', () => {
	// The scenario the guard exists for. Two threads finished while the app was
	// backgrounded on B; the user taps A's notification. B must survive — it is
	// a completion the user never looked at, and losing it loses the signal.

	it('spares B when the navigation is already pending (Chromium ordering)', () => {
		// The SW posts navigate_to_conversation, THEN focus() flips visibility,
		// so `navigating` is populated by the time we look.
		const { ack, dismiss, state } = parkedOn('b');
		state.pending = 'a';
		ack.becameVisible();
		vi.advanceTimersByTime(ACK_DEFER_MS);
		expect(dismiss).not.toHaveBeenCalled();
	});

	it('spares B when visibility lands first and the message follows (iOS ordering)', () => {
		// The OS foregrounds the PWA before notificationclick has posted — and
		// the SW is usually cold, so that can take a few hundred ms. At the
		// moment of the visibility flip there is no pending navigation at all.
		// This is the case the deferral exists for: checking inline would
		// dismiss B here.
		const { ack, dismiss, state } = parkedOn('b');
		ack.becameVisible();
		state.pending = 'a'; // the SW finally boots and its message lands
		vi.advanceTimersByTime(ACK_DEFER_MS);
		expect(dismiss).not.toHaveBeenCalled();
	});

	it('spares B on a cold launch, where mount itself is the notification tap', () => {
		// iOS reclaimed the process. Tapping A's notification relaunches the
		// PWA at B (where it was parked), the SW finds that restored window and
		// drives the navigation from there. SvelteKit sets no `navigating` for
		// that initial entry, so mount has nothing to check against — which is
		// why mount defers too.
		const { ack, dismiss, state } = harness({ conversationId: 'b' });
		ack.conversationChanged();
		state.pending = 'a';
		vi.advanceTimersByTime(ACK_DEFER_MS);
		expect(dismiss).not.toHaveBeenCalled();
	});

	it('acknowledges A once the navigation completes', () => {
		const { ack, dismiss, state } = parkedOn('b');
		state.pending = 'a';
		ack.becameVisible();
		vi.advanceTimersByTime(ACK_DEFER_MS);
		state.conversationId = 'a';
		state.pending = undefined;
		ack.conversationChanged();
		expect(dismiss).toHaveBeenCalledExactlyOnceWith('a');
	});

	it('acknowledges only A when the navigation completes mid-defer', () => {
		// The two paths overlap: the timer is still pending when the navigation
		// lands and acknowledges synchronously, then the timer fires too. The
		// duplicate is harmless (dismissal is idempotent and the badge is
		// recounted from the tray afterwards) — what matters is that B is never
		// dismissed, and that the timer re-reads the id rather than closing
		// over the one it was scheduled with.
		const { ack, dismiss, state } = parkedOn('b');
		state.pending = 'a';
		ack.becameVisible();
		vi.advanceTimersByTime(ACK_DEFER_MS / 2);
		state.conversationId = 'a';
		state.pending = undefined;
		ack.conversationChanged();
		vi.advanceTimersByTime(ACK_DEFER_MS);
		expect(dismiss).not.toHaveBeenCalledWith('b');
		expect(dismiss).toHaveBeenCalledWith('a');
	});

	it('acknowledges B when the window is merely swiped back into, no tap', () => {
		// The control case: no navigation pending, so returning to B is a
		// genuine visit and B's notification should go.
		const { ack, dismiss } = parkedOn('b');
		ack.becameVisible();
		vi.advanceTimersByTime(ACK_DEFER_MS);
		expect(dismiss).toHaveBeenCalledWith('b');
	});
});
