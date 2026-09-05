/**
 * `recheckEndpoint` — the forced reachability probe behind the admin view's
 * Recheck button.
 *
 * The case worth pinning is the config-error one: `getEndpointsStatus` catches
 * `ConfigError` and renders it as a first-class state, so the recheck path
 * catching it too is what keeps the two consistent. Letting it escape answered
 * the operator's click with a 500 in exactly the situation that state exists to
 * explain.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const getEndpointMock = vi.hoisted(() => vi.fn());
const listEndpointsMock = vi.hoisted(() => vi.fn(() => []));
vi.mock('$lib/server/endpoints/registry', () => ({
	getEndpoint: getEndpointMock,
	listEndpoints: listEndpointsMock,
}));

const listUpstreamModelsMock = vi.hoisted(() => vi.fn(async () => []));
vi.mock('$lib/server/endpoints/client', () => ({
	listUpstreamModels: listUpstreamModelsMock,
	UpstreamError: class UpstreamError extends Error {
		status?: number;
	},
}));

import { ConfigError } from '$lib/server/endpoints/config';
import { recheckEndpoint, resetModelCache } from '$lib/server/endpoints/list-models';

afterEach(() => {
	resetModelCache();
	vi.clearAllMocks();
	listUpstreamModelsMock.mockImplementation(async () => []);
});

describe('recheckEndpoint', () => {
	it('reports a broken config as "no such endpoint" rather than throwing', async () => {
		// `getRegistry` deliberately does not memoize a failed load, so a config
		// that broke while the page was open throws on the NEXT read — which is
		// this one, from a button the operator just pressed.
		getEndpointMock.mockImplementation(() => {
			throw new ConfigError('endpoints[0]: base_url is required');
		});
		await expect(recheckEndpoint('dirac')).resolves.toBe(false);
		expect(listUpstreamModelsMock).not.toHaveBeenCalled();
	});

	it('rethrows a non-config failure instead of swallowing it as a 404', async () => {
		getEndpointMock.mockImplementation(() => {
			throw new TypeError('boom');
		});
		await expect(recheckEndpoint('dirac')).rejects.toThrow(TypeError);
	});

	it('returns false for an unknown id without probing', async () => {
		getEndpointMock.mockReturnValue(undefined);
		await expect(recheckEndpoint('nope')).resolves.toBe(false);
		expect(listUpstreamModelsMock).not.toHaveBeenCalled();
	});

	it('probes a known endpoint and reports success even when the probe fails', async () => {
		// An unreachable endpoint is the ANSWER, not an error: the failure lands on
		// the cache entry as `error`, which is what the caller renders.
		getEndpointMock.mockReturnValue({ id: 'dirac', displayName: 'dirac' });
		listUpstreamModelsMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
		await expect(recheckEndpoint('dirac')).resolves.toBe(true);
		expect(listUpstreamModelsMock).toHaveBeenCalledOnce();
	});
});
