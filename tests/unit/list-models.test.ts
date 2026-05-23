/**
 * Tests for the per-endpoint stale-while-revalidate cache that backs
 * the layout's model list. The behaviors that matter are concurrency-
 * shaped (background refresh, in-flight dedup, error preservation),
 * which is exactly the kind of stateful logic that quietly regresses
 * without a test net.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadedEndpoint } from '$lib/server/endpoints/config';
import type { UpstreamModel } from '$lib/types/api';

const mocks = vi.hoisted(() => ({
	listUpstreamModels: vi.fn<(endpoint: LoadedEndpoint) => Promise<UpstreamModel[]>>(),
	listEndpoints: vi.fn<() => LoadedEndpoint[]>()
}));

vi.mock('$lib/server/endpoints/client', async () => {
	// Real UpstreamError so the error-message formatting branch is exercised
	// instead of stubbed.
	const actual = await vi.importActual<typeof import('$lib/server/endpoints/client')>(
		'$lib/server/endpoints/client'
	);
	return {
		...actual,
		listUpstreamModels: mocks.listUpstreamModels
	};
});

vi.mock('$lib/server/endpoints/registry', () => ({
	listEndpoints: mocks.listEndpoints
}));

import { listAllModels, listAllModelsWithErrors, resetModelCache } from '$lib/server/endpoints/list-models';
import { ConfigError } from '$lib/server/endpoints/config';
import { UpstreamError } from '$lib/server/endpoints/client';

/** Minimal LoadedEndpoint shape — fields touched by normalizeUpstreamModel. */
function endpoint(id: string, overrides: Partial<LoadedEndpoint> = {}): LoadedEndpoint {
	return {
		id,
		baseUrl: `https://${id}.example.com/v1`,
		displayName: id,
		apiKey: null,
		groupBy: 'endpoint',
		providerQuirk: 'passthrough',
		requestTimeoutSeconds: 30,
		...overrides
	} as LoadedEndpoint;
}

beforeEach(() => {
	resetModelCache();
	mocks.listUpstreamModels.mockReset();
	mocks.listEndpoints.mockReset();
});

afterEach(() => {
	resetModelCache();
});

describe('listAllModels — cold cache', () => {
	it('returns [] silently on ConfigError instead of throwing', async () => {
		mocks.listEndpoints.mockImplementation(() => {
			throw new ConfigError('bad config');
		});
		await expect(listAllModels()).resolves.toEqual([]);
		expect(mocks.listUpstreamModels).not.toHaveBeenCalled();
	});

	it('re-throws non-ConfigError exceptions from listEndpoints', async () => {
		mocks.listEndpoints.mockImplementation(() => {
			throw new TypeError('not a config error');
		});
		await expect(listAllModels()).rejects.toThrow(TypeError);
	});

	it('fetches each configured endpoint and normalizes its models', async () => {
		mocks.listEndpoints.mockReturnValue([endpoint('a'), endpoint('b')]);
		mocks.listUpstreamModels.mockImplementation(async (ep) => [
			{ id: `${ep.id}-model-1` },
			{ id: `${ep.id}-model-2` }
		]);
		const models = await listAllModels();
		expect(models.map((m) => m.id).sort()).toEqual([
			'a::a-model-1',
			'a::a-model-2',
			'b::b-model-1',
			'b::b-model-2'
		]);
		expect(mocks.listUpstreamModels).toHaveBeenCalledTimes(2);
	});

	it('caches the result so a second call within TTL hits zero upstreams', async () => {
		mocks.listEndpoints.mockReturnValue([endpoint('a')]);
		mocks.listUpstreamModels.mockResolvedValue([{ id: 'm' }]);
		await listAllModels();
		await listAllModels();
		expect(mocks.listUpstreamModels).toHaveBeenCalledTimes(1);
	});
});

describe('listAllModels — concurrent cold requests dedup', () => {
	it('shares one upstream call across concurrent waiters', async () => {
		mocks.listEndpoints.mockReturnValue([endpoint('a')]);
		let release!: (v: UpstreamModel[]) => void;
		mocks.listUpstreamModels.mockReturnValue(
			new Promise<UpstreamModel[]>((res) => {
				release = res;
			})
		);
		const p1 = listAllModels();
		const p2 = listAllModels();
		const p3 = listAllModels();
		release([{ id: 'm' }]);
		const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
		expect(r1).toEqual(r2);
		expect(r2).toEqual(r3);
		expect(mocks.listUpstreamModels).toHaveBeenCalledTimes(1);
	});
});

describe('listAllModels — stale-while-revalidate', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('returns stale data immediately past TTL and refreshes in background', async () => {
		mocks.listEndpoints.mockReturnValue([endpoint('a')]);
		mocks.listUpstreamModels.mockResolvedValueOnce([{ id: 'old' }]);
		const first = await listAllModels();
		expect(first.map((m) => m.id)).toEqual(['a::old']);

		// Advance past the 60s TTL.
		vi.advanceTimersByTime(61_000);

		mocks.listUpstreamModels.mockResolvedValueOnce([{ id: 'new' }]);
		const second = await listAllModels();
		// Stale read should be served instantly — pre-refresh.
		expect(second.map((m) => m.id)).toEqual(['a::old']);

		// The background refresh is still in flight; flush it.
		await vi.waitFor(() => {
			expect(mocks.listUpstreamModels).toHaveBeenCalledTimes(2);
		});

		// Next read sees the refreshed data without another upstream call.
		const third = await listAllModels();
		expect(third.map((m) => m.id)).toEqual(['a::new']);
		expect(mocks.listUpstreamModels).toHaveBeenCalledTimes(2);
	});

	it('past-TTL request schedules at most one background refresh across concurrent callers', async () => {
		mocks.listEndpoints.mockReturnValue([endpoint('a')]);
		mocks.listUpstreamModels.mockResolvedValueOnce([{ id: 'old' }]);
		await listAllModels();

		vi.advanceTimersByTime(61_000);

		let release!: (v: UpstreamModel[]) => void;
		mocks.listUpstreamModels.mockReturnValueOnce(
			new Promise<UpstreamModel[]>((res) => {
				release = res;
			})
		);
		// Three back-to-back stale reads while the refresh is in flight.
		await Promise.all([listAllModels(), listAllModels(), listAllModels()]);
		release([{ id: 'new' }]);
		await vi.waitFor(() => {
			expect(mocks.listUpstreamModels).toHaveBeenCalledTimes(2);
		});
		// 1 cold + 1 refresh, NOT 1 + 3.
		expect(mocks.listUpstreamModels).toHaveBeenCalledTimes(2);
	});
});

describe('listAllModelsWithErrors — error preservation', () => {
	it('preserves prior models across a refresh failure and reports the error', async () => {
		mocks.listEndpoints.mockReturnValue([endpoint('a')]);
		mocks.listUpstreamModels.mockResolvedValueOnce([{ id: 'm' }]);
		const first = await listAllModelsWithErrors();
		expect(first[0].models.map((m) => m.id)).toEqual(['a::m']);
		expect(first[0].error).toBeNull();

		vi.useFakeTimers();
		try {
			vi.advanceTimersByTime(61_000);

			mocks.listUpstreamModels.mockRejectedValueOnce(
				new UpstreamError('Endpoint "a" returned HTTP 503', 503, '{"error":"down"}')
			);
			// Stale read — succeeds with prior data; refresh fires in background.
			const stale = await listAllModelsWithErrors();
			expect(stale[0].models.map((m) => m.id)).toEqual(['a::m']);

			await vi.waitFor(() => {
				expect(mocks.listUpstreamModels).toHaveBeenCalledTimes(2);
			});

			// Next read sees the prior models AND the recorded error — a flapping
			// upstream shouldn't blank the picker.
			const next = await listAllModelsWithErrors();
			expect(next[0].models.map((m) => m.id)).toEqual(['a::m']);
			expect(next[0].error).toContain('HTTP 503');
			expect(next[0].error).toContain('status 503');
		} finally {
			vi.useRealTimers();
		}
	});

	it('formats non-UpstreamError exceptions via .message', async () => {
		mocks.listEndpoints.mockReturnValue([endpoint('a')]);
		mocks.listUpstreamModels.mockRejectedValueOnce(new Error('socket hang up'));
		const res = await listAllModelsWithErrors();
		expect(res[0].models).toEqual([]);
		expect(res[0].error).toBe('socket hang up');
	});

	it('reports each endpoint independently — one failure does not blank the others', async () => {
		mocks.listEndpoints.mockReturnValue([endpoint('good'), endpoint('bad')]);
		mocks.listUpstreamModels.mockImplementation(async (ep) => {
			if (ep.id === 'bad') throw new Error('nope');
			return [{ id: 'works' }];
		});
		const res = await listAllModelsWithErrors();
		const byId = Object.fromEntries(res.map((r) => [r.endpointId, r]));
		expect(byId.good.models.map((m) => m.id)).toEqual(['good::works']);
		expect(byId.good.error).toBeNull();
		expect(byId.bad.models).toEqual([]);
		expect(byId.bad.error).toBe('nope');
	});
});

describe('resetModelCache', () => {
	it('clears the cache so the next call re-fetches', async () => {
		mocks.listEndpoints.mockReturnValue([endpoint('a')]);
		mocks.listUpstreamModels.mockResolvedValue([{ id: 'm' }]);
		await listAllModels();
		expect(mocks.listUpstreamModels).toHaveBeenCalledTimes(1);

		resetModelCache();
		await listAllModels();
		expect(mocks.listUpstreamModels).toHaveBeenCalledTimes(2);
	});
});
