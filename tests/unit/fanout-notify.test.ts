/**
 * Unit tests for the fan-out aggregate-notification coordinator. The decision
 * logic — fire only on the LAST branch (empty in-flight registry), skip when
 * nothing was produced, count by the client's fan-out size with a produced-count
 * fallback, and the per-modality noun — is the valuable part, so its three
 * collaborators (in-flight registry, sibling query, push) are mocked and the
 * coordinator is driven directly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getInFlightEntries = vi.fn();
const getSiblingAssistants = vi.fn();
const notifyConversationComplete = vi.fn();

vi.mock('$lib/server/streaming/in-flight', () => ({
	getInFlightEntries: (...a: unknown[]) => getInFlightEntries(...a),
}));
vi.mock('$lib/server/db/queries/messages', () => ({
	getSiblingAssistants: (...a: unknown[]) => getSiblingAssistants(...a),
}));
vi.mock('$lib/server/push/notify', () => ({
	notifyConversationComplete: (...a: unknown[]) => notifyConversationComplete(...a),
}));

import { notifyFanoutCompleteIfLast } from '$lib/server/messages/fanout-notify';

/** N stand-in sibling rows (only the id is read). */
function siblings(n: number) {
	return Array.from({ length: n }, (_, i) => ({ id: `a${i}` }));
}

const base = {
	conversationId: 'c1',
	userId: 'u',
	userMessageId: 'um1',
	conversationTitle: 'My chat' as string | null,
	modality: 'image' as const,
};

beforeEach(() => {
	getInFlightEntries.mockReset();
	getSiblingAssistants.mockReset();
	notifyConversationComplete.mockReset();
});

describe('notifyFanoutCompleteIfLast', () => {
	it('does nothing while other branches are still in flight', () => {
		getInFlightEntries.mockReturnValue([{}, {}]); // 2 still running
		notifyFanoutCompleteIfLast({ ...base, fanoutSize: 4 });
		expect(notifyConversationComplete).not.toHaveBeenCalled();
		// Short-circuits before even querying siblings.
		expect(getSiblingAssistants).not.toHaveBeenCalled();
	});

	it('skips when the last branch settled but nothing was produced', () => {
		getInFlightEntries.mockReturnValue([]); // last branch
		getSiblingAssistants.mockReturnValue([]); // all failed / cancelled
		notifyFanoutCompleteIfLast({ ...base, fanoutSize: 4 });
		expect(notifyConversationComplete).not.toHaveBeenCalled();
	});

	it('fires exactly one aggregate when the last branch settles', () => {
		getInFlightEntries.mockReturnValue([]);
		getSiblingAssistants.mockReturnValue(siblings(4));
		notifyFanoutCompleteIfLast({ ...base, fanoutSize: 4 });
		expect(notifyConversationComplete).toHaveBeenCalledTimes(1);
		expect(notifyConversationComplete).toHaveBeenCalledWith(
			expect.objectContaining({
				conversationId: 'c1',
				userId: 'u',
				// References the shared user message (no single "the" assistant).
				assistantMessageId: 'um1',
				conversationTitle: 'My chat',
				modality: 'image',
				summary: '4 images ready',
			}),
		);
	});

	it('shows the dispatched fan-out size even when a branch failed', () => {
		getInFlightEntries.mockReturnValue([]);
		getSiblingAssistants.mockReturnValue(siblings(3)); // 1 of 4 failed
		notifyFanoutCompleteIfLast({ ...base, fanoutSize: 4 });
		expect(notifyConversationComplete).toHaveBeenCalledWith(
			expect.objectContaining({ summary: '4 images ready' }),
		);
	});

	it('falls back to the produced count when fanoutSize is absent', () => {
		getInFlightEntries.mockReturnValue([]);
		getSiblingAssistants.mockReturnValue(siblings(2));
		notifyFanoutCompleteIfLast({ ...base }); // no fanoutSize
		expect(notifyConversationComplete).toHaveBeenCalledWith(
			expect.objectContaining({ summary: '2 images ready' }),
		);
	});

	it('uses the right noun per modality and pluralizes by count', () => {
		getInFlightEntries.mockReturnValue([]);

		getSiblingAssistants.mockReturnValue(siblings(3));
		notifyFanoutCompleteIfLast({ ...base, modality: 'chat', fanoutSize: 3 });
		expect(notifyConversationComplete).toHaveBeenLastCalledWith(
			expect.objectContaining({ summary: '3 responses ready' }),
		);

		getSiblingAssistants.mockReturnValue(siblings(1));
		notifyFanoutCompleteIfLast({ ...base, modality: 'video', fanoutSize: 1 });
		expect(notifyConversationComplete).toHaveBeenLastCalledWith(
			expect.objectContaining({ summary: '1 video ready' }),
		);
	});

	it('falls back to "New conversation" for a null title', () => {
		getInFlightEntries.mockReturnValue([]);
		getSiblingAssistants.mockReturnValue(siblings(2));
		notifyFanoutCompleteIfLast({ ...base, conversationTitle: null, fanoutSize: 2 });
		expect(notifyConversationComplete).toHaveBeenCalledWith(
			expect.objectContaining({ conversationTitle: 'New conversation' }),
		);
	});
});
