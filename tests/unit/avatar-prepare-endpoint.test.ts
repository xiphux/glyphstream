/**
 * Route-handler tests for POST /api/conversations/[id]/avatar/prepare.
 *
 * This route decides two things once, before any branch of an avatar comparison
 * is dispatched — the two things a branch request must not be left to re-decide
 * N times concurrently:
 *
 *   1. WHETHER the comparison may park here. It has to park on the description,
 *      because `getFanoutRecoveryState` only reports a fan-out whose marker is
 *      the active leaf — that's what lets a reloaded page rebuild the grid. So
 *      the leaf has to end up on the description, and moving it there is only
 *      safe while nothing is hanging below it but a dead-end portrait.
 *   2. WHAT the grid starts from. The recovery rebuild seeds every assistant
 *      child of the anchor, so the live grid has to as well, and the page can't
 *      supply that list — it renders the active branch, which holds at most one
 *      of those siblings.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '$lib/types/api';

const mocks = vi.hoisted(() => ({
	getConversationMeta: vi.fn<(...a: unknown[]) => unknown>(),
	setFanoutParent: vi.fn<(...a: unknown[]) => void>(),
	getMessage: vi.fn<(...a: unknown[]) => unknown>(),
	getSiblingAssistants: vi.fn<(...a: unknown[]) => ChatMessage[]>(),
	hasChildMessages: vi.fn<(...a: unknown[]) => boolean>(),
	setActiveLeafMessageId: vi.fn<(...a: unknown[]) => void>(),
}));

vi.mock('$lib/server/db/queries/conversations', () => ({
	getConversationMeta: (...a: unknown[]) => mocks.getConversationMeta(...a),
	setFanoutParent: (...a: unknown[]) => mocks.setFanoutParent(...a),
}));
vi.mock('$lib/server/db/queries/messages', () => ({
	getMessage: (...a: unknown[]) => mocks.getMessage(...a),
	getSiblingAssistants: (...a: unknown[]) => mocks.getSiblingAssistants(...a),
	hasChildMessages: (...a: unknown[]) => mocks.hasChildMessages(...a),
	setActiveLeafMessageId: (...a: unknown[]) => mocks.setActiveLeafMessageId(...a),
}));

import { POST } from '../../src/routes/api/conversations/[id]/avatar/prepare/+server';

/** The description the portraits hang under. */
const DESCRIPTION = { id: 'desc', role: 'assistant', parts: [], parentMessageId: 'u1' };
/** A portrait already drawn from it. */
const PORTRAIT = { id: 'p1', role: 'assistant', parts: [], parentMessageId: 'desc' };

function call(sourceMessageId: unknown = 'desc') {
	const url = new URL('http://x/api/conversations/c1/avatar/prepare');
	const request = new Request(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ sourceMessageId }),
	});
	return POST({
		locals: { user: { id: 'u1' } },
		params: { id: 'c1' },
		request,
		url,
	} as unknown as Parameters<typeof POST>[0]);
}

/** Point the conversation's active leaf somewhere. */
function leafIs(id: string | null) {
	mocks.getConversationMeta.mockReturnValue({ id: 'c1', title: 'T', activeLeafMessageId: id });
}

beforeEach(() => {
	mocks.getConversationMeta.mockReset();
	leafIs('desc');
	mocks.setFanoutParent.mockReset();
	mocks.setActiveLeafMessageId.mockReset();
	mocks.hasChildMessages.mockReset().mockReturnValue(false);
	mocks.getSiblingAssistants.mockReset().mockReturnValue([]);
	mocks.getMessage.mockReset().mockImplementation((_c: unknown, id: unknown) => {
		if (id === 'desc') return DESCRIPTION;
		if (id === 'p1') return PORTRAIT;
		if (id === 'later') return { id: 'later', role: 'user', parts: [], parentMessageId: 'p1' };
		return null;
	});
});

describe('POST /avatar/prepare — where a comparison may park', () => {
	it('parks on the description when it is already the leaf', async () => {
		// The ordinary case: the description is the newest thing in the thread,
		// because it was the reply to the request that produced it.
		await call();
		expect(mocks.setFanoutParent.mock.calls).toEqual([['c1', 'u1', 'desc']]);
		// Nothing to move, so nothing is moved — a needless write here would bump
		// `updated_at` and reorder the sidebar for a comparison that hasn't started.
		expect(mocks.setActiveLeafMessageId).not.toHaveBeenCalled();
	});

	it('steps the leaf back off a dead-end portrait (the re-roll case)', async () => {
		// "I drew one, now let me compare three." The leaf sits on that portrait;
		// stepping onto its parent hides nothing, because the portrait comes
		// straight back as a column in the grid.
		leafIs('p1');
		await call();
		expect(mocks.setActiveLeafMessageId.mock.calls).toEqual([['c1', 'desc']]);
		expect(mocks.setFanoutParent.mock.calls).toEqual([['c1', 'u1', 'desc']]);
	});

	it('refuses once the conversation has continued past the description', async () => {
		// Those later turns hang off ONE portrait. Parking would hide them, and
		// picking a different portrait would leave them on an unpicked branch — so
		// the answer is no, and the client falls back to the single-model draw.
		leafIs('later');
		await expect(call()).rejects.toMatchObject({ status: 409 });
		expect(mocks.setActiveLeafMessageId).not.toHaveBeenCalled();
		expect(mocks.setFanoutParent).not.toHaveBeenCalled();
	});

	it('refuses a portrait that has been continued from', async () => {
		// Same rule, reached by the branch the active-message list can't see: this
		// portrait's children live on a branch the page isn't rendering, which is
		// exactly why the client's version of this check is only an affordance.
		leafIs('p1');
		mocks.hasChildMessages.mockReturnValue(true);
		await expect(call()).rejects.toMatchObject({ status: 409 });
		expect(mocks.setFanoutParent).not.toHaveBeenCalled();
	});
});

describe('POST /avatar/prepare — what the grid starts from', () => {
	it('returns every portrait already drawn from the description', async () => {
		// Not just the one on the active branch. The recovery rebuild reads all of
		// them, so a grid that seeded fewer would silently grow on reload.
		const siblings = [PORTRAIT, { ...PORTRAIT, id: 'p2' }] as unknown as ChatMessage[];
		mocks.getSiblingAssistants.mockReturnValue(siblings);
		const res = await call();
		expect(await res.json()).toEqual({ siblings });
		expect(mocks.getSiblingAssistants.mock.calls).toEqual([['c1', 'desc']]);
	});

	it('rejects an unknown message', async () => {
		await expect(call('nope')).rejects.toMatchObject({ status: 404 });
	});

	it('rejects a source id that is not a string', async () => {
		// Covers the absent case too — a missing field arrives as undefined and
		// fails the same `typeof` guard.
		await expect(call(null)).rejects.toMatchObject({ status: 400 });
	});

	it('rejects a conversation the user does not own', async () => {
		// getMessage is scoped to the conversation but not to the user, so this is
		// the only thing standing between a guessed id and someone else's thread.
		mocks.getConversationMeta.mockReturnValue(null);
		await expect(call()).rejects.toMatchObject({ status: 404 });
	});
});
