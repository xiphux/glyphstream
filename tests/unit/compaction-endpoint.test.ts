/**
 * Route-handler tests for POST /api/conversations/[id]/compact. The compaction
 * engine + relay have their own tests; this pins the thin endpoint marshalling:
 * the fan-out and too-short 409 guards and the SSE response. Deps are mocked so
 * no DB/config/registry is needed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isHttpError, type HttpError } from '@sveltejs/kit';

const mocks = vi.hoisted(() => ({
	getConversationMeta: vi.fn<(...a: unknown[]) => unknown>(),
	getFanoutParent: vi.fn<(...a: unknown[]) => string | null>(),
	prepareCompaction: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
	streamCompaction: vi.fn<(...a: unknown[]) => ReadableStream<Uint8Array>>(),
}));

vi.mock('#lib/server/db/queries/conversations.js', () => ({
	getConversationMeta: (...a: unknown[]) => mocks.getConversationMeta(...a),
	getFanoutParent: (...a: unknown[]) => mocks.getFanoutParent(...a),
}));
vi.mock('#lib/server/chat/compaction.js', () => ({
	prepareCompaction: (...a: unknown[]) => mocks.prepareCompaction(...a),
}));
vi.mock('#lib/server/streaming/compaction-relay.js', () => ({
	streamCompaction: (...a: unknown[]) => mocks.streamCompaction(...a),
}));

import { POST } from '../../src/routes/api/conversations/[id]/compact/+server';

type Args = { stream?: boolean; userId?: string | null };
function call(args: Args = {}) {
	const url = new URL(`http://x/api/conversations/c1/compact${args.stream ? '?stream=1' : ''}`);
	const locals = {
		user: args.userId === undefined ? { id: 'u1' } : args.userId ? { id: args.userId } : null,
	};
	const request = { signal: undefined } as unknown as Request;

	return POST({ locals, params: { id: 'c1' }, request, url } as unknown as Parameters<
		typeof POST
	>[0]);
}

async function expectHttpError(fn: () => unknown): Promise<HttpError> {
	try {
		await (async () => fn())();
	} catch (e) {
		if (isHttpError(e)) return e;
		throw e;
	}
	throw new Error('expected an HttpError, none thrown');
}

beforeEach(() => {
	mocks.getConversationMeta.mockReset().mockReturnValue({ id: 'c1' }); // owned + found
	mocks.getFanoutParent.mockReset().mockReturnValue(null);
	mocks.prepareCompaction.mockReset();
	mocks.streamCompaction.mockReset().mockReturnValue(new ReadableStream());
});

describe('POST /compact — guards', () => {
	it('404s when the conversation is not found / not owned', async () => {
		mocks.getConversationMeta.mockReturnValue(null);
		const err = await expectHttpError(() => call());
		expect(err.status).toBe(404);
	});

	it('409s when a fan-out comparison is parked', async () => {
		mocks.getFanoutParent.mockReturnValue('shared-user-msg');
		const err = await expectHttpError(() => call({ stream: true }));
		expect(err.status).toBe(409);
		expect(err.body.message).toMatch(/comparison/i);
		// Never reached the engine — the guard short-circuits.
		expect(mocks.prepareCompaction).not.toHaveBeenCalled();
	});
});

describe('POST /compact — stream', () => {
	it('409s when there is nothing to compact (prepare returns null)', async () => {
		mocks.prepareCompaction.mockResolvedValue(null);
		const err = await expectHttpError(() => call({ stream: true }));
		expect(err.status).toBe(409);
		expect(mocks.streamCompaction).not.toHaveBeenCalled();
	});

	it('returns an SSE response when a plan exists', async () => {
		mocks.prepareCompaction.mockResolvedValue({ endpoint: { id: 'e' } });
		const res = await call({ stream: true });
		expect(res.headers.get('Content-Type')).toBe('text/event-stream');
		expect(mocks.streamCompaction).toHaveBeenCalledOnce();
	});

	it('streams without ?stream=1 too', async () => {
		mocks.prepareCompaction.mockResolvedValue({ endpoint: { id: 'e' } });
		const res = await call();
		expect(res.headers.get('Content-Type')).toBe('text/event-stream');
	});
});
