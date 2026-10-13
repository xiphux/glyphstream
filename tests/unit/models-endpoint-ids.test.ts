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
	listEndpoints: vi.fn<() => unknown[]>(() => []),
	ConfigError: class ConfigError extends Error {},
}));

vi.mock('#lib/server/auth/guard.js', () => ({ requireUser: () => {} }));
vi.mock('#lib/server/endpoints/registry.js', () => ({
	listEndpoints: () => mocks.listEndpoints(),
}));
vi.mock('#lib/server/endpoints/config.js', () => ({ ConfigError: mocks.ConfigError }));
vi.mock('#lib/server/endpoints/list-models.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/endpoints/list-models.js')>()),
	listAllModelsWithErrors: () => Promise.resolve(mocks.results()),
}));

import { GET } from '../../src/routes/api/models/+server';

function model(id: string) {
	const [endpointId, upstreamId] = id.split('::');
	return { id, endpointId, upstreamId, displayName: upstreamId, kind: 'chat' };
}

async function get(ids: string | null, role: 'admin' | 'user' = 'user') {
	const url = new URL(`http://x/api/models${ids === null ? '' : `?ids=${ids}`}`);
	const res = await GET({
		locals: { user: { id: 'u1', role } },
		url,
	} as unknown as Parameters<typeof GET>[0]);
	return (await (res as Response).json()) as {
		data: Array<{ id: string }>;
		endpoint_errors: Array<{ endpointId: string; error: string }>;
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

describe('GET /api/models — error detail is for admins', () => {
	const raw =
		'Network error listing models from http://10.0.0.5:8080/v1/models: connect ECONNREFUSED 10.0.0.5:8080';

	it.each([null, 'ep::a'])('keeps the upstream URL from a non-admin (ids=%s)', async (ids) => {
		mocks.results.mockReturnValue([{ endpointId: 'ep', models: [], error: raw }]);
		const body = await get(ids, 'user');
		expect(body.endpoint_errors).toEqual([
			{ endpointId: 'ep', error: 'The model server could not be reached.' },
		]);
	});

	it.each([null, 'ep::a'])('gives an admin the full error (ids=%s)', async (ids) => {
		mocks.results.mockReturnValue([{ endpointId: 'ep', models: [], error: raw }]);
		const body = await get(ids, 'admin');
		expect(body.endpoint_errors).toEqual([{ endpointId: 'ep', error: raw }]);
	});

	it('keeps the config path and env var name from a non-admin', async () => {
		const detail = '/srv/glyphstream/config.toml: endpoint "ep" expects env var BRIDGE_KEY';
		mocks.listEndpoints.mockImplementationOnce(() => {
			throw new mocks.ConfigError(detail);
		});
		await expect(get(null, 'user')).rejects.toMatchObject({
			status: 500,
			body: { message: 'Endpoint configuration is invalid. Ask an administrator to check it.' },
		});
		mocks.listEndpoints.mockImplementationOnce(() => {
			throw new mocks.ConfigError(detail);
		});
		await expect(get(null, 'admin')).rejects.toMatchObject({
			status: 500,
			body: { message: `Endpoint configuration is invalid: ${detail}` },
		});
	});
});
