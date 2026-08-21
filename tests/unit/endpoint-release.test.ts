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
		await expect(releaseEndpointResources(ep())).resolves.toBe(false);
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

describe('authentication', () => {
	it("carries the endpoint's api key on every management call", async () => {
		// A llama-server started with --api-key answers 401 otherwise, and since
		// failure here is swallowed, the whole release would quietly no-op and
		// hand a still-occupied GPU to the next generation.
		const seen: Array<string | undefined> = [];
		vi.stubGlobal(
			'fetch',
			vi.fn((url: string, init?: RequestInit) => {
				seen.push(new Headers(init?.headers).get('authorization') ?? undefined);
				if (String(url).includes('/slots'))
					return Promise.resolve(json([{ is_processing: false }]));
				if (String(url).includes('/unload')) return Promise.resolve(json({ success: true }));
				return Promise.resolve(models([['big', seen.length > 2 ? 'unloaded' : 'loaded']]));
			}),
		);

		await releaseEndpointResources({ ...ep(), apiKey: 'sk-test' });

		expect(seen.length).toBeGreaterThan(2);
		expect(seen.every((h) => h === 'Bearer sk-test')).toBe(true);
	});

	it('sends no Authorization header when the endpoint has no key', async () => {
		let header: string | null = 'unset';
		vi.stubGlobal(
			'fetch',
			vi.fn((_url: string, init?: RequestInit) => {
				header = new Headers(init?.headers).get('authorization');
				return Promise.resolve(models([]));
			}),
		);
		await releaseEndpointResources(ep());
		expect(header).toBeNull();
	});
});

describe('an abort landing in a poll sleep', () => {
	/** Busy slots, so the wait loop is sitting in `sleep` when the signal fires. */
	function stubBusyThenAbort(ac: AbortController, reason: unknown) {
		vi.stubGlobal(
			'fetch',
			vi.fn((url: string) => {
				if (String(url).includes('/slots')) {
					setTimeout(() => ac.abort(reason), 5);
					return Promise.resolve(json([{ is_processing: true }]));
				}
				return Promise.resolve(models([['big', 'loaded']]));
			}),
		);
	}

	it('keeps a non-abort reason non-fatal', async () => {
		// The title generator passes `AbortSignal.timeout(…)`, whose reason is a
		// TimeoutError — a swallowable failure like any other. Minting our own
		// AbortError here turned it into the one error we rethrow, which the
		// caller treats as the user's Stop.
		const ac = new AbortController();
		stubBusyThenAbort(ac, new DOMException('timed out', 'TimeoutError'));
		await expect(releaseEndpointResources(ep(), ac.signal)).resolves.toBe(false);
	});

	it('still rethrows a real abort', async () => {
		const ac = new AbortController();
		stubBusyThenAbort(ac, new DOMException('aborted', 'AbortError'));
		await expect(releaseEndpointResources(ep(), ac.signal)).rejects.toThrow(/abort/i);
	});
});

describe('when the backend will not fully cooperate', () => {
	it("keeps unloading the rest after one model's unload fails", async () => {
		// The try used to wrap the whole loop, so a transient 503 on the first
		// model abandoned every model behind it — silently leaving them resident,
		// which is the OOM this exists to prevent, on any router holding two.
		const posted: string[] = [];
		let listed = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn((url: string, init?: RequestInit) => {
				const u = String(url);
				if (u.includes('/slots')) return Promise.resolve(json([{ is_processing: false }]));
				if (u.includes('/unload')) {
					const { model } = JSON.parse((init?.body as string) ?? '{}') as { model: string };
					posted.push(model);
					return Promise.resolve(
						model === 'big' ? new Response('busy', { status: 503 }) : json({ success: true }),
					);
				}
				listed++;
				// First call lists both; later polls report 'draft' gone, 'big' stuck.
				return Promise.resolve(
					listed === 1
						? models([
								['big', 'loaded'],
								['draft', 'loaded'],
							])
						: models([['big', 'loaded']]),
				);
			}),
		);

		const freed = await releaseEndpointResources(ep());

		expect(posted).toEqual(['big', 'draft']);
		expect(freed).toBe(false);
	});

	it('reports failure rather than a silent success', async () => {
		// The caller has to be able to tell "we tried" from "it worked" — a failure
		// recorded as a handover makes the retry skip the eviction it needs.
		stubFetch(() => new Response('nope', { status: 500 }));
		await expect(releaseEndpointResources(ep())).resolves.toBe(false);
	});

	it('reports success when there was nothing loaded to free', async () => {
		stubFetch(() => models([]));
		await expect(releaseEndpointResources(ep())).resolves.toBe(true);
	});

	it('warns at warn level when a model stays busy, not debug', async () => {
		// LOG_LEVEL defaults to info, so a debug-gated message means an operator
		// watching a production log sees the mechanism fail at its one job in
		// total silence, and finds out from the OOM instead.
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		stubFetch((url) =>
			String(url).includes('/slots')
				? json([{ is_processing: true }])
				: models([['big', 'loaded']]),
		);

		// The give-up is a 60s wall-clock deadline; drive it rather than wait it.
		vi.useFakeTimers();
		try {
			const pending = releaseEndpointResources(ep());
			await vi.advanceTimersByTimeAsync(61_000);
			expect(await pending).toBe(false);
		} finally {
			vi.useRealTimers();
		}

		expect(warn).toHaveBeenCalledWith(expect.stringContaining('still busy'));
		warn.mockRestore();
	});
});

describe('a backend that is not a router', () => {
	it('fails loudly instead of reporting a successful handover', async () => {
		// A plain llama-server answers /models with rows that carry no status.
		// Treating that as "nothing loaded" made the whole feature validate, do
		// nothing, and log nothing — the one failure mode the warn-everything
		// contract exists to rule out.
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		stubFetch(() => json({ data: [{ id: 'some-model' }, { id: 'another' }] }));

		await expect(releaseEndpointResources(ep())).resolves.toBe(false);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('router mode'));
		warn.mockRestore();
	});

	it('still treats a genuinely empty model list as nothing to do', async () => {
		stubFetch(() => json({ data: [] }));
		await expect(releaseEndpointResources(ep())).resolves.toBe(true);
	});
});

describe('diagnostics an operator actually reads', () => {
	it('reports the wait that happened, not the constant it was capped by', async () => {
		// The per-model deadline is clamped by the overall budget, so quoting the
		// constant can overstate the real wait by orders of magnitude — on the one
		// line that tells an operator the GPU was never freed.
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		stubFetch((url) =>
			String(url).includes('/slots')
				? json([{ is_processing: true }])
				: models([['big', 'loaded']]),
		);

		vi.useFakeTimers();
		try {
			const pending = releaseEndpointResources(ep());
			await vi.advanceTimersByTimeAsync(61_000);
			expect(await pending).toBe(false);
		} finally {
			vi.useRealTimers();
		}

		const line = warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes('still busy'));
		expect(line).toBeDefined();
		// A real elapsed figure, not the literal BUSY_WAIT_MS.
		const ms = Number(/after (\d+)ms/.exec(line ?? '')?.[1]);
		expect(ms).toBeGreaterThan(0);
		warn.mockRestore();
	});

	it('does not mistake an idle router for a non-router during the unload poll', async () => {
		// The is-this-a-router check runs only on the first listing. On the
		// confirmation poll a status-less row is indistinguishable from the unload
		// having worked, so applying it there would report success as failure and
		// re-evict on every later acquire.
		let listings = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn((url: string) => {
				const u = String(url);
				if (u.includes('/slots')) return Promise.resolve(json([{ is_processing: false }]));
				if (u.includes('/unload')) return Promise.resolve(json({ success: true }));
				listings++;
				// First listing is a proper router response; the confirmation poll
				// still lists the model but carries no status information — which is
				// exactly the shape the is-this-a-router heuristic rejects.
				return Promise.resolve(
					listings === 1 ? models([['big', 'loaded']]) : json({ data: [{ id: 'big' }] }),
				);
			}),
		);

		await expect(releaseEndpointResources(ep())).resolves.toBe(true);
	});
});
