/**
 * `deleteConversation` sends the user's "Also delete media" answer as chosen —
 * the sidebar dialog and the archived list both go through it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('#lib/notification-dismiss.js', () => ({
	dismissConversationNotifications: vi.fn(async () => {}),
}));

import { deleteConversation } from '#lib/conversation-actions.js';
import { dismissConversationNotifications } from '#lib/notification-dismiss.js';

function stubFetch(status = 204) {
	const fetchMock = vi.fn(
		async (_url: string, _init?: RequestInit) => new Response(null, { status }),
	);
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.mocked(dismissConversationNotifications).mockClear();
});

describe('deleteConversation', () => {
	it('keeps the media when the box is unticked', async () => {
		const fetchMock = stubFetch();
		await deleteConversation('c1', false);
		expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/api/conversations/c1', {
			method: 'DELETE',
		});
		expect(dismissConversationNotifications).toHaveBeenCalledWith('c1');
	});

	it('asks for the media to go too when the box is ticked', async () => {
		const fetchMock = stubFetch();
		await deleteConversation('c1', true);
		expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/api/conversations/c1?deleteMedia=true', {
			method: 'DELETE',
		});
	});

	it('treats a 404 as already deleted', async () => {
		stubFetch(404);
		await expect(deleteConversation('c1', false)).resolves.toBeUndefined();
	});

	it("throws the server's message on a failure", async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(JSON.stringify({ message: 'nope' }), { status: 500 })),
		);
		await expect(deleteConversation('c1', false)).rejects.toThrow('nope');
		expect(dismissConversationNotifications).not.toHaveBeenCalled();
	});
});
