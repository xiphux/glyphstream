import { afterEach, describe, expect, it, vi } from 'vitest';

// Control the config loader and endpoint registry without touching disk.
const loadMock = vi.hoisted(() => vi.fn());
const getEndpointMock = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/endpoints/config', () => ({ loadRerankConfig: loadMock }));
vi.mock('$lib/server/endpoints/registry', () => ({ getEndpoint: getEndpointMock }));

import {
	resolveRerankConfig,
	_resetRerankConfigCacheForTests,
} from '$lib/server/retrieval/rerank-config';

afterEach(() => {
	_resetRerankConfigCacheForTests();
	loadMock.mockReset();
	getEndpointMock.mockReset();
});

const loaded = {
	endpointId: 'rr',
	modelId: 'bge',
	timeoutSeconds: 30,
	topN: 20,
	quirk: undefined as 'tei' | undefined,
};

describe('resolveRerankConfig resilience', () => {
	it('degrades to undefined (does not throw) when the config file is unreadable', () => {
		loadMock.mockImplementation(() => {
			throw new Error('Could not read config file at /nope/config.toml: ENOENT');
		});
		expect(() => resolveRerankConfig()).not.toThrow();
		expect(resolveRerankConfig()).toBeUndefined();
	});

	it('returns undefined when no [rerank] block is configured', () => {
		loadMock.mockReturnValue(null);
		expect(resolveRerankConfig()).toBeUndefined();
	});

	it('returns undefined when the named endpoint no longer resolves', () => {
		loadMock.mockReturnValue(loaded);
		getEndpointMock.mockReturnValue(undefined);
		expect(resolveRerankConfig()).toBeUndefined();
	});

	it('resolves into a RerankConfig with the endpoint and tuning carried through', () => {
		const endpoint = { id: 'rr', baseUrl: 'http://rr/v1' };
		loadMock.mockReturnValue({ ...loaded, quirk: 'tei', topN: 12 });
		getEndpointMock.mockReturnValue(endpoint);
		expect(resolveRerankConfig()).toEqual({
			endpoint,
			modelId: 'bge',
			timeoutSeconds: 30,
			topN: 12,
			quirk: 'tei',
		});
	});
});
