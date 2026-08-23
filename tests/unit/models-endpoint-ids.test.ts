/**
 * Route-handler test for `GET /api/models?ids=`.
 *
 * The client caches an absence as an answer: an id it asked about and did not
 * get back is remembered as "not configured", permanently, and never re-asked.
 * That inference is only sound when the endpoint that would have answered was
 * reachable — and `listAllModelsWithErrors` degrades a cold, failing endpoint to
 * ZERO models, which looks identical.
 *
 * `endpoint_errors` is the only thing that distinguishes the two, so the contract
 * is asserted here rather than only in the client's unit tests. Those stub the
 * response themselves, which means they can (and did) go on passing against a
 * shape this handler never actually produced.
 */
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	results: vi.fn<() => Array<{ endpointId: string; models: unknown[]; error?: string }>>(),
}));

vi.mock('$lib/server/auth/guard', () => ({ requireUser: () => {} }));
vi.mock('$lib/server/endpoints/registry', () => ({ listEndpoints: () => [] }));
vi.mock('$lib/server/endpoints/config', () => ({ ConfigError: class extends Error {} }));
vi.mock('$lib/server/endpoints/list-models', () => ({
	listAllModelsWithErrors: () => Promise.resolve(mocks.results()),
}));

import { GET } from '../../src/routes/api/models/+server';

function model(id: string) {
	const [endpointId, upstreamId] = id.split('::');
	return { id, endpointId, upstreamId, displayName: upstreamId, kind: 'chat' };
}

async function get(ids: string | null) {
	const url = new URL(`http://x/api/models${ids === null ? '' : `?ids=${ids}`}`);
	const res = await GET({
		locals: { user: { id: 'u1', role: 'user' } },
		url,
	} as unknown as Parameters<typeof GET>[0]);
	return (await (res as Response).json()) as {
		data: Array<{ id: string }>;
		endpoint_errors: Array<{ endpointId: string }>;
	};
}

describe('GET /api/models?ids=', () => {
	it('returns only the requested ids', async () => {
		mocks.results.mockReturnValue([
			{ endpointId: 'ep', models: [model('ep::a'), model('ep::b'), model('ep::c')] },
		]);
		const body = await get('ep::a,ep::c');
		expect(body.data.map((m) => m.id)).toEqual(['ep::a', 'ep::c']);
	});

	it('reports NO errors when every endpoint answered — so an absence is definitive', async () => {
		mocks.results.mockReturnValue([{ endpointId: 'ep', models: [model('ep::a')] }]);
		const body = await get('ep::a,ep::gone');
		expect(body.data.map((m) => m.id)).toEqual(['ep::a']);
		expect(body.endpoint_errors).toEqual([]);
	});

	it('reports the error when the endpoint owning a requested id is down', async () => {
		// The case the client must not cache. Without this field it sees an empty
		// `data` and concludes the model does not exist — for the life of the page.
		mocks.results.mockReturnValue([{ endpointId: 'ep', models: [], error: 'ECONNREFUSED' }]);
		const body = await get('ep::a');
		expect(body.data).toEqual([]);
		expect(body.endpoint_errors.map((e) => e.endpointId)).toEqual(['ep']);
	});

	it('does not report an unrelated endpoint’s outage', async () => {
		// Scoped on purpose: a lookup against a healthy endpoint stays authoritative
		// even while some other upstream is broken, or nothing would ever cache.
		mocks.results.mockReturnValue([
			{ endpointId: 'ep', models: [model('ep::a')] },
			{ endpointId: 'other', models: [], error: 'ECONNREFUSED' },
		]);
		const body = await get('ep::a');
		expect(body.endpoint_errors).toEqual([]);
	});

	it('still reports every error on the full listing', async () => {
		// The unscoped branch is a banner feed and keeps its existing contract.
		mocks.results.mockReturnValue([
			{ endpointId: 'ep', models: [model('ep::a')] },
			{ endpointId: 'other', models: [], error: 'ECONNREFUSED' },
		]);
		const body = await get(null);
		expect(body.endpoint_errors.map((e) => e.endpointId)).toEqual(['other']);
	});
});
