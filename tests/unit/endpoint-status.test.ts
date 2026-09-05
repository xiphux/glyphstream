/**
 * Unit tests for the admin endpoint-status aggregator.
 *
 * Two things here are contracts rather than behaviour, and both are silent when
 * broken: the DTO must never carry the resolved `apiKey` (a spread of
 * `LoadedEndpoint` type-checks and ships the secret), and health must
 * distinguish "the probe failed but we still have models" from "we have
 * nothing" — collapsing those reports an outage on one blipped /v1/models.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelEntry } from '$lib/types/api';

const listEndpointsMock = vi.hoisted(() => vi.fn());
const getModelCacheEntryMock = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/endpoints/registry', () => ({ listEndpoints: listEndpointsMock }));
vi.mock('$lib/server/endpoints/list-models', () => ({
	getModelCacheEntry: getModelCacheEntryMock,
}));

const releaseMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock('$lib/server/endpoints/release', () => ({ releaseEndpointResources: releaseMock }));

import { acquireEndpointSlot, resetEndpointGatesForTests } from '$lib/server/endpoints/concurrency';
import { ConfigError, type LoadedEndpoint } from '$lib/server/endpoints/config';
import { getEndpointsStatus } from '$lib/server/endpoints/status';

function ep(over: Partial<LoadedEndpoint> & { id: string }): LoadedEndpoint {
	return {
		displayName: over.id,
		baseUrl: `http://${over.id}/v1`,
		apiKey: null,
		requestTimeoutSeconds: 120,
		providerQuirk: 'passthrough',
		groupBy: 'endpoint',
		supportsTools: false,
		maxConcurrent: 4,
		resourceGroup: over.id,
		resourceGroupMaxConcurrent: 4,
		release: null,
		contextWindow: null,
		modelContextWindows: {},
		modelPromptStyles: {},
		modelPromptHints: {},
		...over,
	};
}

function model(id: string, kind: ModelEntry['kind']): ModelEntry {
	return {
		id,
		endpointId: 'dirac',
		upstreamId: id,
		displayName: id,
		ownedBy: null,
		kind,
		kindKnown: true,
		group: 'dirac',
		groupKey: 'dirac',
		supportsTools: false,
		contextWindow: null,
		promptStyle: null,
		promptHint: null,
	};
}

/** A cache entry as `getModelCacheEntry` returns one. */
function cached(models: ModelEntry[], error: string | null = null) {
	return { models, error, fetchedAt: 1_000, durationMs: 12, expiresAt: 61_000 };
}

/** Touch the gate so a snapshot exists for the group, at `cap`. */
function gateFor(endpoint: LoadedEndpoint, cap: number) {
	const withCap = { ...endpoint, resourceGroupMaxConcurrent: cap };
	void acquireEndpointSlot(withCap, { work: { purpose: 'other' } }).then((s) => s.release());
}

beforeEach(() => {
	getModelCacheEntryMock.mockReturnValue(null);
});

afterEach(() => {
	resetEndpointGatesForTests();
	vi.clearAllMocks();
});

describe('getEndpointsStatus', () => {
	it('never puts the resolved api key on the wire', () => {
		// The reason status.ts writes every field by hand instead of spreading.
		listEndpointsMock.mockReturnValue([ep({ id: 'dirac', apiKey: 'sk-super-secret' })]);
		const status = getEndpointsStatus();
		expect(JSON.stringify(status)).not.toContain('sk-super-secret');
		expect(status.groups[0].endpoints[0].hasApiKey).toBe(true);
	});

	it('reports no api key as such rather than omitting the field', () => {
		listEndpointsMock.mockReturnValue([ep({ id: 'dirac' })]);
		expect(getEndpointsStatus().groups[0].endpoints[0].hasApiKey).toBe(false);
	});

	it('carries no conversation or user identity', () => {
		// The gate holds work without user identity and this surface must not be
		// the place that reintroduces it.
		listEndpointsMock.mockReturnValue([ep({ id: 'dirac' })]);
		const serialized = JSON.stringify(getEndpointsStatus());
		expect(serialized).not.toMatch(/conversationId|userId/);
	});

	it('counts models by kind from the cache', () => {
		listEndpointsMock.mockReturnValue([ep({ id: 'dirac' })]);
		getModelCacheEntryMock.mockReturnValue(
			cached([model('a', 'chat'), model('b', 'chat'), model('c', 'image')]),
		);
		const e = getEndpointsStatus().groups[0].endpoints[0];
		expect(e.modelCount).toBe(3);
		expect(e.modelsByKind).toEqual({ chat: 2, image: 1, video: 0, embedding: 0 });
		expect(e.health).toBe('ok');
		expect(e.checkedAt).toBe(1_000);
		expect(e.latencyMs).toBe(12);
	});

	it('is `unknown`, not `down`, before anything has probed it', () => {
		// A cold process has never called /v1/models. Rendering that as an outage
		// would make a healthy install look broken for its first minute.
		listEndpointsMock.mockReturnValue([ep({ id: 'dirac' })]);
		const e = getEndpointsStatus().groups[0].endpoints[0];
		expect(e.health).toBe('unknown');
		expect(e.checkedAt).toBeNull();
		expect(e.modelCount).toBe(0);
	});

	it('is `degraded` when a probe failed but earlier models survive', () => {
		listEndpointsMock.mockReturnValue([ep({ id: 'dirac' })]);
		getModelCacheEntryMock.mockReturnValue(cached([model('a', 'chat')], 'fetch failed'));
		const e = getEndpointsStatus().groups[0].endpoints[0];
		expect(e.health).toBe('degraded');
		expect(e.error).toBe('fetch failed');
		expect(e.modelCount).toBe(1);
	});

	it('is `down` when a probe failed with nothing cached', () => {
		listEndpointsMock.mockReturnValue([ep({ id: 'dirac' })]);
		getModelCacheEntryMock.mockReturnValue(cached([], 'ECONNREFUSED'));
		expect(getEndpointsStatus().groups[0].endpoints[0].health).toBe('down');
	});

	it('renders an idle endpoint at its configured cap with no gate yet', () => {
		// No traffic means no gate. The group still has to report a capacity, and
		// it comes from config rather than from a fabricated zero.
		listEndpointsMock.mockReturnValue([
			ep({ id: 'dirac', maxConcurrent: 1, resourceGroupMaxConcurrent: 1 }),
		]);
		const g = getEndpointsStatus().groups[0];
		expect(g).toMatchObject({ active: 0, waiting: 0, maxConcurrent: 1, lastHolderId: null });
		expect(g.endpoints[0].active).toEqual([]);
	});

	it('groups shared-GPU endpoints under one gate and attributes slots per member', async () => {
		const llama = ep({
			id: 'llama',
			resourceGroup: 'gpu0',
			maxConcurrent: 1,
			resourceGroupMaxConcurrent: 1,
		});
		const comfy = ep({
			id: 'comfy',
			resourceGroup: 'gpu0',
			maxConcurrent: 4,
			resourceGroupMaxConcurrent: 1,
		});
		listEndpointsMock.mockReturnValue([llama, comfy]);

		const held = await acquireEndpointSlot(llama, {
			work: { purpose: 'chat', modelId: 'llama::gemma' },
		});
		const queued = acquireEndpointSlot(comfy, { work: { purpose: 'image', modelId: 'flux' } });

		const groups = getEndpointsStatus().groups;
		expect(groups).toHaveLength(1);
		const g = groups[0];
		expect(g.resourceGroup).toBe('gpu0');
		expect(g).toMatchObject({ active: 1, waiting: 1, maxConcurrent: 1, lastHolderId: 'llama' });

		const [llamaStatus, comfyStatus] = g.endpoints;
		// Bare: the `llama::` prefix is redundant next to `endpointId`, and is
		// stripped so every row on a card spells a model the same way.
		expect(llamaStatus.active.map((s) => s.modelId)).toEqual(['gemma']);
		expect(llamaStatus.queued).toEqual([]);
		// The waiter belongs to comfy even though the busy slot is llama's — the
		// distinction a group-level count cannot make.
		expect(comfyStatus.active).toEqual([]);
		expect(comfyStatus.queued.map((s) => s.modelId)).toEqual(['flux']);
		// Its own max_concurrent is 4, but the group holds it to the strictest
		// member's 1 — both numbers are reported so that isn't a mystery.
		expect(comfyStatus.maxConcurrent).toBe(4);

		held.release();
		(await queued).release();
	});

	it('surfaces background work that never reaches the in-flight registry', async () => {
		// The reason the gate is the source of truth: a dreaming sweep occupies a
		// cap-1 box and registers nowhere else.
		const dirac = ep({ id: 'dirac', maxConcurrent: 1, resourceGroupMaxConcurrent: 1 });
		listEndpointsMock.mockReturnValue([dirac]);
		const slot = await acquireEndpointSlot(dirac, {
			work: { purpose: 'dream', modelId: 'dirac::small' },
		});
		expect(getEndpointsStatus().groups[0].endpoints[0].active).toEqual([
			expect.objectContaining({ purpose: 'dream', modelId: 'small', state: 'active' }),
		]);
		slot.release();
	});

	it('renders one spelling whether the caller held a composite or a bare id', async () => {
		// The nine acquiring paths legitimately hold different forms: a chat turn
		// has the conversation-facing `endpoint::model`, while compaction and the
		// memory tasks resolve from config and hold the bare upstream id. Passed
		// through, the same model appeared two ways in one endpoint's list.
		const dirac = ep({ id: 'dirac' });
		listEndpointsMock.mockReturnValue([dirac]);
		const composite = await acquireEndpointSlot(dirac, {
			work: { purpose: 'chat', modelId: 'dirac::gemma-4-26b' },
		});
		const bare = await acquireEndpointSlot(dirac, {
			work: { purpose: 'compaction', modelId: 'gemma-4-26b' },
		});
		expect(getEndpointsStatus().groups[0].endpoints[0].active.map((s) => s.modelId)).toEqual([
			'gemma-4-26b',
			'gemma-4-26b',
		]);
		composite.release();
		bare.release();
	});

	it('keeps a prefix that names a different endpoint than the slot is on', async () => {
		// That combination means a generation was dispatched somewhere other than
		// where its model lives — a routing bug. The page exists to surface exactly
		// that, so the evidence stays visible rather than being tidied away.
		const dirac = ep({ id: 'dirac' });
		listEndpointsMock.mockReturnValue([dirac]);
		const slot = await acquireEndpointSlot(dirac, {
			work: { purpose: 'chat', modelId: 'comfy::flux-dev' },
		});
		expect(getEndpointsStatus().groups[0].endpoints[0].active[0].modelId).toBe('comfy::flux-dev');
		slot.release();
	});

	it('truncates a model id long enough to bloat the polled payload', async () => {
		// `modelId` is the one request-derived field on this surface: the send path
		// checks only that it parses as `<endpointId>::<something>` with a known
		// endpoint, so the upstream half is arbitrary user text.
		const dirac = ep({ id: 'dirac' });
		listEndpointsMock.mockReturnValue([dirac]);
		const slot = await acquireEndpointSlot(dirac, {
			work: { purpose: 'chat', modelId: `dirac::${'A'.repeat(5000)}` },
		});
		// 128 chars of NAME: the clamp runs after the endpoint prefix is split off,
		// so a long prefix can't eat into the budget for the model's own id.
		const rendered = getEndpointsStatus().groups[0].endpoints[0].active[0].modelId!;
		expect(rendered).toHaveLength(128);
		expect(rendered.startsWith('dirac::')).toBe(false);
		slot.release();
	});

	it('keeps a group the gate calls unlimited unlimited', () => {
		// `max: null` means unlimited, not absent — a `??` here would fall through
		// to the config value for a group the gate has already answered for.
		const open = ep({
			id: 'open',
			maxConcurrent: 8,
			resourceGroupMaxConcurrent: 8,
		});
		listEndpointsMock.mockReturnValue([open]);
		gateFor(open, Infinity);
		expect(getEndpointsStatus().groups[0].maxConcurrent).toBeNull();
	});

	it('reports a bad config as a state, not an exception', () => {
		listEndpointsMock.mockImplementation(() => {
			throw new ConfigError('endpoints[0]: base_url is required');
		});
		const status = getEndpointsStatus();
		expect(status.groups).toEqual([]);
		expect(status.configError).toBe('endpoints[0]: base_url is required');
	});

	it('rethrows a non-config failure instead of pretending the config is bad', () => {
		listEndpointsMock.mockImplementation(() => {
			throw new TypeError('boom');
		});
		expect(() => getEndpointsStatus()).toThrow(TypeError);
	});

	it('keeps config order for endpoints and groups', () => {
		listEndpointsMock.mockReturnValue([
			ep({ id: 'zeta' }),
			ep({ id: 'alpha', resourceGroup: 'gpu0' }),
			ep({ id: 'mid' }),
			ep({ id: 'beta', resourceGroup: 'gpu0' }),
		]);
		const groups = getEndpointsStatus().groups;
		expect(groups.map((g) => g.resourceGroup)).toEqual(['zeta', 'gpu0', 'mid']);
		expect(groups[1].endpoints.map((e) => e.id)).toEqual(['alpha', 'beta']);
	});
});
