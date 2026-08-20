/**
 * The llama.cpp release strategy — the half that actually reclaims VRAM.
 *
 * Every case here is a property observed against a live llama.cpp router, not
 * inferred from its docs: the management API sits outside `/v1`, `/slots`
 * autoloads, and `unload` answers success before it has finished.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	isReleaseStrategy,
	managementRootFrom,
	releaseEndpointResources,
} from '$lib/server/endpoints/release';
import type { LoadedEndpoint } from '$lib/server/endpoints/config';

function ep(release: LoadedEndpoint['release'] = 'llama-cpp-router'): LoadedEndpoint {
	return {
		id: 'llama',
		displayName: 'Llama',
		baseUrl: 'http://gpu-box:8081/v1',
		apiKey: null,
		requestTimeoutSeconds: 120,
		providerQuirk: 'passthrough',
		groupBy: 'endpoint',
		supportsTools: true,
		maxConcurrent: 1,
		resourceGroup: 'gpu0',
		resourceGroupMaxConcurrent: 1,
		release,
		contextWindow: null,
		modelContextWindows: {},
		modelPromptStyles: {},
		modelPromptHints: {},
	};
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const models = (rows: Array<[string, string]>) =>
	json({ data: rows.map(([id, value]) => ({ id, status: { value } })) });

afterEach(() => vi.unstubAllGlobals());

/** Records every request and answers from a queue of handlers per path. */
function stubFetch(handlers: (url: string, init?: RequestInit) => Response | Promise<Response>) {
	const calls: string[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn((url: string, init?: RequestInit) => {
			calls.push(`${init?.method ?? 'GET'} ${url.replace('http://gpu-box:8081', '')}`);
			return Promise.resolve(handlers(url, init));
		}),
	);
	return calls;
}

describe('managementRootFrom', () => {
	it("strips the OpenAI /v1 to reach llama.cpp's management API", () => {
		expect(managementRootFrom('http://gpu-box:8081/v1')).toBe('http://gpu-box:8081');
		expect(managementRootFrom('http://gpu-box:8081/v1/')).toBe('http://gpu-box:8081');
	});

	it('keeps a path prefix, which a reverse proxy may need', () => {
		expect(managementRootFrom('https://host/llama/v1')).toBe('https://host/llama');
	});

	it('leaves a base_url that never had /v1 alone', () => {
		expect(managementRootFrom('http://gpu-box:8081')).toBe('http://gpu-box:8081');
	});
});

describe('isReleaseStrategy', () => {
	it('accepts the known strategy and rejects anything else', () => {
		expect(isReleaseStrategy('llama-cpp-router')).toBe(true);
		expect(isReleaseStrategy('llama')).toBe(false);
		expect(isReleaseStrategy(null)).toBe(false);
	});
});

describe('releaseEndpointResources', () => {
	it('does nothing at all for an endpoint with no strategy', async () => {
		const calls = stubFetch(() => json({}));
		await releaseEndpointResources(ep(null));
		expect(calls).toEqual([]);
	});

	it('never probes /slots for a model that is not loaded', async () => {
		// The trap: /slots?model= AUTOLOADS. Probing to decide whether to unload
		// would load the model — the opposite of the point, on the expensive
		// operation. Only already-loaded models may be touched.
		const calls = stubFetch(() =>
			models([
				['a', 'unloaded'],
				['b', 'unloaded'],
			]),
		);
		await releaseEndpointResources(ep());
		expect(calls).toEqual(['GET /models']);
	});

	it('waits for the unload to take effect, not for the 200', async () => {
		// unload answers {"success":true} before the model is gone; trusting it
		// hands a still-occupied GPU to the next generation.
		let unloadCalled = false;
		const calls = stubFetch((url, init) => {
			if (url.endsWith('/slots?model=big')) return json([{ is_processing: false }]);
			if (init?.method === 'POST') {
				unloadCalled = true;
				return json({ success: true });
			}
			// Still loaded on the first poll after the unload, gone on the next.
			return models([['big', unloadCalled ? 'unloaded' : 'loaded']]);
		});

		await releaseEndpointResources(ep());
		expect(calls).toEqual([
			'GET /models',
			'GET /slots?model=big',
			'POST /models/unload',
			'GET /models',
		]);
	});

	it('queues behind a model that is mid-inference rather than yanking it', async () => {
		// It can't be our traffic — the gate only releases an idle group — so a
		// busy slot is someone else's request, and we wait as if we were behind
		// them in line.
		let probes = 0;
		const calls = stubFetch((url, init) => {
			if (url.includes('/slots')) {
				probes++;
				return json([{ is_processing: probes < 3 }]);
			}
			if (init?.method === 'POST') return json({ success: true });
			return models([['big', probes >= 3 ? 'unloaded' : 'loaded']]);
		});

		await releaseEndpointResources(ep());
		expect(probes).toBe(3);
		expect(calls.filter((c) => c.startsWith('POST'))).toEqual(['POST /models/unload']);
	});

	it('resolves rather than throwing when the backend will not cooperate', async () => {
		// Best-effort: failing the user's generation because an unrelated backend
		// wouldn't let go is worse than the status quo, where we'd simply have
		// attempted it anyway.
		stubFetch(() => new Response('nope', { status: 500 }));
		await expect(releaseEndpointResources(ep())).resolves.toBeUndefined();
	});

	it('rethrows an abort, so a cancelled generation stops waiting', async () => {
		const ac = new AbortController();
		stubFetch(() => {
			ac.abort();
			throw new DOMException('aborted', 'AbortError');
		});
		await expect(releaseEndpointResources(ep(), ac.signal)).rejects.toThrow(/abort/i);
	});
});
