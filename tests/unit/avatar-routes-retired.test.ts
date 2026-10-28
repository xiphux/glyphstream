/**
 * The avatar routes a portrait used to be drawn through, before portraits
 * became versions on their reply (POST …/photos with `kind: 'portrait'`). A tab
 * still running that release is told to reload rather than drawing into a
 * thread that no longer reads what it would write.
 */
import { describe, expect, it } from 'vitest';
import { POST as generate } from '../../src/routes/api/conversations/[id]/avatar/generate/+server';
import { POST as prepare } from '../../src/routes/api/conversations/[id]/avatar/prepare/+server';
import { POST as pick } from '../../src/routes/api/conversations/[id]/avatar/pick/+server';

type Handler = typeof generate;

async function call(handler: Handler) {
	const url = new URL('http://x/api/conversations/c1/avatar/generate');
	try {
		await handler({
			locals: { user: { id: 'u1' } },
			params: { id: 'c1' },
			request: new Request(url, { method: 'POST', body: '{}' }),
			url,
		} as unknown as Parameters<Handler>[0]);
	} catch (e) {
		return e as { status: number; body: { message: string } };
	}
	throw new Error('expected a refusal');
}

describe('retired avatar routes', () => {
	it.each([
		['generate', generate],
		['prepare', prepare],
		['pick', pick],
	] as const)('%s tells an old tab to reload', async (_name, handler) => {
		const e = await call(handler as Handler);
		expect(e.status).toBe(409);
		expect(e.body.message).toMatch(/reload the page/);
	});
});
