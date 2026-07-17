/**
 * Route-handler tests for POST /api/presence — the cross-device presence
 * heartbeat.
 *
 * Auth is mocked to a no-op (the 401 is the shared `requireUser` guard, tested
 * at its own seam); everything else runs against the REAL presence registry so
 * these assert the actual endpoint→registry wiring, not a mock of it. Covers
 * the input guards (non-empty strings, the MAX_ID_LEN cap, boolean `visible`)
 * and that a valid beat records under the authenticated user — including that a
 * spoofed body userId can't be reached, and that visible:false clears.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/auth/guard', () => ({ requireUser: () => {} }));

import { POST } from '../../src/routes/api/presence/+server';
import { isConversationBeingViewed, resetPresence } from '$lib/server/push/presence';

async function post(body: unknown, userId = 'u1'): Promise<Response> {
	return POST({
		locals: { user: { id: userId } },
		request: new Request('http://x/api/presence', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		}),
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	} as any);
}

/** Invoke POST with an invalid body and return the thrown HttpError status. */
async function postStatus(body: unknown): Promise<number> {
	try {
		await post(body);
	} catch (e) {
		return (e as { status: number }).status;
	}
	throw new Error('expected the handler to throw');
}

beforeEach(() => resetPresence());
afterEach(() => resetPresence());

describe('POST /api/presence', () => {
	it('records a visible beat into the registry and answers 204', async () => {
		const res = await post({ conversationId: 'c1', viewerId: 'v1', visible: true });
		expect(res.status).toBe(204);
		expect(isConversationBeingViewed('u1', 'c1')).toBe(true);
	});

	it('files presence under the authenticated user, not any body-supplied id', async () => {
		await post({ conversationId: 'c1', viewerId: 'v1', visible: true }, 'owner');
		expect(isConversationBeingViewed('owner', 'c1')).toBe(true);
		// The griefing guard: no way to record presence against another user.
		expect(isConversationBeingViewed('victim', 'c1')).toBe(false);
	});

	it('a visible:false beat clears the viewer', async () => {
		await post({ conversationId: 'c1', viewerId: 'v1', visible: true });
		await post({ conversationId: 'c1', viewerId: 'v1', visible: false });
		expect(isConversationBeingViewed('u1', 'c1')).toBe(false);
	});

	it('rejects a missing or empty conversationId', async () => {
		expect(await postStatus({ viewerId: 'v1', visible: true })).toBe(400);
		expect(await postStatus({ conversationId: '', viewerId: 'v1', visible: true })).toBe(400);
	});

	it('rejects a missing viewerId', async () => {
		expect(await postStatus({ conversationId: 'c1', visible: true })).toBe(400);
	});

	it('rejects a non-boolean visible', async () => {
		expect(await postStatus({ conversationId: 'c1', viewerId: 'v1' })).toBe(400);
		expect(await postStatus({ conversationId: 'c1', viewerId: 'v1', visible: 'yes' })).toBe(400);
	});

	it('enforces the MAX_ID_LEN cap but accepts an id right at the boundary', async () => {
		const tooLong = 'x'.repeat(201);
		expect(await postStatus({ conversationId: tooLong, viewerId: 'v1', visible: true })).toBe(400);
		expect(await postStatus({ conversationId: 'c1', viewerId: tooLong, visible: true })).toBe(400);
		const res = await post({ conversationId: 'x'.repeat(200), viewerId: 'v1', visible: true });
		expect(res.status).toBe(204);
	});
});
