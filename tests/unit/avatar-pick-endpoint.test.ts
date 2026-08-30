/**
 * Route-handler tests for POST /api/conversations/[id]/avatar/pick.
 *
 * Resolving an avatar comparison is one user action — "use this one" — that has
 * to move two things: the conversation's face and its active branch. They live
 * behind one endpoint rather than two client calls precisely so a failure can't
 * land one and lose the other, leaving the header wearing a face from a branch
 * the thread isn't on. So the interesting assertions here are about what happens
 * when half of it fails.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	getConversationMeta: vi.fn<(...a: unknown[]) => unknown>(),
	setConversationAvatar: vi.fn<(...a: unknown[]) => { ok: boolean; reason?: string }>(),
	getMessage: vi.fn<(...a: unknown[]) => unknown>(),
	selectBranch: vi.fn<(...a: unknown[]) => { newActiveLeaf: string } | null>(),
	getFanoutParent: vi.fn<(...a: unknown[]) => string | null>(),
}));

vi.mock('$lib/server/db/queries/conversations', () => ({
	getConversationMeta: (...a: unknown[]) => mocks.getConversationMeta(...a),
	setConversationAvatar: (...a: unknown[]) => mocks.setConversationAvatar(...a),
	getFanoutParent: (...a: unknown[]) => mocks.getFanoutParent(...a),
}));
vi.mock('$lib/server/db/queries/messages', () => ({
	getMessage: (...a: unknown[]) => mocks.getMessage(...a),
	selectBranch: (...a: unknown[]) => mocks.selectBranch(...a),
}));

import { POST } from '../../src/routes/api/conversations/[id]/avatar/pick/+server';

const PORTRAIT = {
	id: 'p1',
	role: 'assistant',
	parts: [{ type: 'image', mediaId: 'media-42' }],
	parentMessageId: 'desc',
};

function call(messageId: unknown = 'p1') {
	const url = new URL('http://x/api/conversations/c1/avatar/pick');
	const request = new Request(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ messageId }),
	});
	return POST({
		locals: { user: { id: 'u1' } },
		params: { id: 'c1' },
		request,
		url,
	} as unknown as Parameters<typeof POST>[0]);
}

beforeEach(() => {
	mocks.getConversationMeta.mockReset().mockReturnValue({ id: 'c1', title: 'T' });
	mocks.setConversationAvatar.mockReset().mockReturnValue({ ok: true });
	mocks.selectBranch.mockReset().mockReturnValue({ newActiveLeaf: 'p1' });
	mocks.getFanoutParent.mockReset().mockReturnValue('desc');
	mocks.getMessage.mockReset().mockImplementation((_c: unknown, id: unknown) => {
		if (id === 'p1') return PORTRAIT;
		if (id === 'desc')
			return { id: 'desc', role: 'assistant', parts: [{ type: 'text', text: 'x' }] };
		if (id === 'u1') return { id: 'u1', role: 'user', parts: [{ type: 'image', mediaId: 'm' }] };
		return null;
	});
});

describe('POST /avatar/pick', () => {
	it('adopts the portrait and moves the thread onto its branch', async () => {
		const res = await call();
		expect(await res.json()).toEqual({ ok: true, newActiveLeaf: 'p1' });
		// The media id comes off the message server-side; the client sends a message
		// id, never a media id, so a pick can't be steered at unrelated media.
		expect(mocks.setConversationAvatar.mock.calls).toEqual([['c1', 'u1', 'media-42']]);
		expect(mocks.selectBranch.mock.calls).toEqual([['c1', 'p1']]);
	});

	it('leaves the thread where it was when the apply fails', async () => {
		// The avatar half is the one that can legitimately refuse (media reaped,
		// wrong kind). Refusing before the branch moves is what makes a failed pick
		// a no-op instead of half of one.
		mocks.setConversationAvatar.mockReturnValue({ ok: false, reason: 'media_not_found' });
		await expect(call()).rejects.toMatchObject({ status: 400 });
		expect(mocks.selectBranch).not.toHaveBeenCalled();
	});

	it('rejects a message with no image', async () => {
		// The description itself, say — reachable by picking a column whose
		// generation failed, which persists as an error sibling with no image.
		await expect(call('desc')).rejects.toMatchObject({ status: 400 });
		expect(mocks.setConversationAvatar).not.toHaveBeenCalled();
	});

	it('rejects a user message even when it carries an image', async () => {
		// An uploaded attachment is not a portrait this comparison produced.
		await expect(call('u1')).rejects.toMatchObject({ status: 400 });
		expect(mocks.setConversationAvatar).not.toHaveBeenCalled();
	});

	it('rejects a conversation the user does not own', async () => {
		// `getMessage` is conversation-scoped but not user-scoped, so this ownership
		// check is what keeps a guessed conversation id out of someone else's row.
		mocks.getConversationMeta.mockReturnValue(null);
		await expect(call()).rejects.toMatchObject({ status: 404 });
		expect(mocks.setConversationAvatar).not.toHaveBeenCalled();
	});

	it('rejects a portrait from a comparison that is no longer open', async () => {
		// Scoped to the parked anchor, so "set the avatar" cannot double as a
		// navigate-anywhere: without it the endpoint would happily adopt — and
		// switch the thread to — any assistant message in the conversation that
		// carries an image.
		mocks.getFanoutParent.mockReturnValue(null);
		await expect(call()).rejects.toMatchObject({ status: 409 });
		expect(mocks.setConversationAvatar).not.toHaveBeenCalled();
	});

	it('rejects a portrait belonging to a different anchor', async () => {
		mocks.getFanoutParent.mockReturnValue('some-other-description');
		await expect(call()).rejects.toMatchObject({ status: 409 });
		expect(mocks.setConversationAvatar).not.toHaveBeenCalled();
	});

	it('rejects an unknown message', async () => {
		await expect(call('nope')).rejects.toMatchObject({ status: 404 });
	});
});
