/**
 * Unit tests for the gate's WORK BOOKKEEPING — the labelled holder/waiter
 * records behind `getResourceGroupSnapshot`, which is what the admin endpoint
 * view renders.
 *
 * Split from `endpoint-concurrency.test.ts` (which owns the queue semantics)
 * because these assert a different contract: that every path which changes
 * `active` changes the holder set with it. The leak this guards against is
 * silent — a phantom holder never shows up as a wedged gate, only as a page
 * that says an idle box is generating, forever.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const releaseMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock('$lib/server/endpoints/release', () => ({ releaseEndpointResources: releaseMock }));
import {
	acquireEndpointSlot,
	declarePendingWork,
	getResourceGroupSnapshot,
	getResourceQueueDepth,
	resetEndpointGatesForTests,
} from '$lib/server/endpoints/concurrency';
import type { LoadedEndpoint } from '$lib/server/endpoints/config';

function ep(
	id: string,
	max: number,
	group = id,
	release: LoadedEndpoint['release'] = null,
): LoadedEndpoint {
	return {
		id,
		displayName: id,
		baseUrl: `http://${id}/v1`,
		apiKey: null,
		requestTimeoutSeconds: 120,
		providerQuirk: 'passthrough',
		groupBy: 'endpoint',
		supportsTools: false,
		maxConcurrent: max,
		resourceGroup: group,
		resourceGroupMaxConcurrent: max,
		release,
		contextWindow: null,
		modelContextWindows: {},
		modelPromptStyles: {},
		modelPromptHints: {},
	};
}

afterEach(() => {
	resetEndpointGatesForTests();
	releaseMock.mockClear();
	releaseMock.mockImplementation(async () => true);
});

const flush = () => Promise.resolve();

describe('getResourceGroupSnapshot', () => {
	it('is null for a group nothing has ever touched', () => {
		// A configured-but-idle endpoint has no gate yet; the caller renders that
		// case from config rather than getting a fabricated zeroed gate here.
		expect(getResourceGroupSnapshot('never-used')).toBeNull();
	});

	it('names the work holding each slot', async () => {
		const slot = await acquireEndpointSlot(ep('dirac', 2), {
			work: { purpose: 'chat', modelId: 'dirac::gemma-26b' },
		});
		const snap = getResourceGroupSnapshot('dirac')!;
		expect(snap.active).toBe(1);
		expect(snap.holders).toHaveLength(1);
		expect(snap.holders[0]).toMatchObject({
			endpointId: 'dirac',
			purpose: 'chat',
			modelId: 'dirac::gemma-26b',
			state: 'active',
		});
		slot.release();
		expect(getResourceGroupSnapshot('dirac')!.holders).toEqual([]);
	});

	it('carries a deliberately-chosen `other` through, with no model id', async () => {
		// There is no un-declared acquisition left to test — `work` is required, so
		// the compiler rejects one, which is the point. What is still worth pinning
		// is that `other` survives as a real value for work that fits no named kind,
		// and that an absent `modelId` normalizes to null rather than undefined,
		// since the wire type promises `string | null`.
		const slot = await acquireEndpointSlot(ep('dirac', 1), { work: { purpose: 'other' } });
		expect(getResourceGroupSnapshot('dirac')!.holders[0]).toMatchObject({
			purpose: 'other',
			modelId: null,
		});
		slot.release();
	});

	it('reports queued work in line order, marked queued', async () => {
		// The fan-out case the view exists for: several branches stacked behind a
		// cap of 1, each nameable BEFORE it starts.
		const dirac = ep('dirac', 1);
		const held = await acquireEndpointSlot(dirac, { work: { purpose: 'chat', modelId: 'a' } });
		const q1 = acquireEndpointSlot(dirac, { work: { purpose: 'image', modelId: 'flux' } });
		const q2 = acquireEndpointSlot(dirac, { work: { purpose: 'video', modelId: 'wan' } });

		const snap = getResourceGroupSnapshot('dirac')!;
		expect(snap.waiting).toBe(2);
		expect(snap.queued.map((s) => s.modelId)).toEqual(['flux', 'wan']);
		expect(snap.queued.every((s) => s.state === 'queued')).toBe(true);

		held.release();
		(await q1).release();
		(await q2).release();
		expect(getResourceGroupSnapshot('dirac')!).toMatchObject({ holders: [], queued: [] });
	});

	it('moves a granted waiter from queued to active', async () => {
		const dirac = ep('dirac', 1);
		const held = await acquireEndpointSlot(dirac, { work: { purpose: 'chat' } });
		const pending = acquireEndpointSlot(dirac, { work: { purpose: 'title', modelId: 't' } });
		held.release();
		const granted = await pending;

		const snap = getResourceGroupSnapshot('dirac')!;
		expect(snap.queued).toEqual([]);
		expect(snap.holders).toHaveLength(1);
		expect(snap.holders[0]).toMatchObject({ purpose: 'title', state: 'active' });
		granted.release();
	});

	it('splices an aborted waiter out of the queued list', async () => {
		const dirac = ep('dirac', 1);
		const held = await acquireEndpointSlot(dirac, { work: { purpose: 'chat' } });
		const ctrl = new AbortController();
		const pending = acquireEndpointSlot(dirac, {
			signal: ctrl.signal,
			work: { purpose: 'image', modelId: 'flux' },
		});
		expect(getResourceGroupSnapshot('dirac')!.queued).toHaveLength(1);

		ctrl.abort();
		await expect(pending).rejects.toThrow();
		expect(getResourceGroupSnapshot('dirac')!.queued).toEqual([]);
		held.release();
	});

	it('shows the incoming work as `releasing` while a handover evicts', async () => {
		// The longest, least explicable stretch the view has to render: the slot
		// is taken and counted, but nothing is generating yet. It must be
		// attributable to the endpoint that took it.
		const llama = ep('llama', 1, 'gpu0', 'llama-cpp-router');
		const bridge = ep('bridge', 1, 'gpu0');
		let resolveRelease!: () => void;
		releaseMock.mockImplementation(
			() => new Promise<boolean>((r) => (resolveRelease = () => r(true))),
		);

		(await acquireEndpointSlot(llama, { work: { purpose: 'chat' } })).release();
		const pending = acquireEndpointSlot(bridge, { work: { purpose: 'image', modelId: 'flux' } });
		await flush();

		const mid = getResourceGroupSnapshot('gpu0')!;
		expect(mid.evicting).toBe(true);
		expect(mid.lastHolderId).toBe('bridge');
		expect(mid.holders).toHaveLength(1);
		expect(mid.holders[0]).toMatchObject({
			endpointId: 'bridge',
			purpose: 'image',
			state: 'releasing',
		});

		resolveRelease();
		const slot = await pending;
		expect(getResourceGroupSnapshot('gpu0')!.holders[0]).toMatchObject({ state: 'active' });
		slot.release();
		expect(getResourceGroupSnapshot('gpu0')!.holders).toEqual([]);
	});

	it('drops the holder when an eviction throws, not just the slot count', async () => {
		// The unwind path. `active` was already decremented here before this
		// change; without the matching holder delete the group would report a
		// generation that does not exist for the life of the process — and on a
		// cap-1 group that is the permanent state of the page.
		const llama = ep('llama', 1, 'gpu0', 'llama-cpp-router');
		const bridge = ep('bridge', 1, 'gpu0');
		releaseMock.mockImplementation(() => Promise.reject(new DOMException('stopped', 'AbortError')));

		(await acquireEndpointSlot(llama, { work: { purpose: 'chat' } })).release();
		await expect(
			acquireEndpointSlot(bridge, { work: { purpose: 'image', modelId: 'flux' } }),
		).rejects.toThrow();

		expect(getResourceGroupSnapshot('gpu0')).toMatchObject({
			active: 0,
			waiting: 0,
			evicting: false,
			holders: [],
			queued: [],
		});
	});

	it('attributes each slot to its own endpoint within a shared group', async () => {
		// A group-level count can't answer "which member is busy" — that's the
		// whole reason the record carries an endpoint id.
		const llama = ep('llama', 2, 'gpu0');
		const bridge = ep('bridge', 2, 'gpu0');
		const a = await acquireEndpointSlot(llama, { work: { purpose: 'chat', modelId: 'gemma' } });
		const b = await acquireEndpointSlot(bridge, { work: { purpose: 'image', modelId: 'flux' } });

		const snap = getResourceGroupSnapshot('gpu0')!;
		expect(snap.active).toBe(2);
		expect(snap.holders.map((h) => [h.endpointId, h.modelId])).toEqual([
			['llama', 'gemma'],
			['bridge', 'flux'],
		]);
		a.release();
		b.release();
	});

	it('gives every record a distinct id when one pump pass grants several', async () => {
		// The collision this guards against is DETERMINISTIC, not a clock race.
		// While a handover eviction runs, acquisitions queue even though the group
		// is under capacity (`evicting` blocks the fast path). The eviction's
		// `finally` then reopens the gate and pumps, and `pump` grants every
		// eligible waiter in ONE synchronous `while` loop — no await between them,
		// so each record it mints there shares a `Date.now()` by construction. A
		// same-model fan-out gives them the same endpoint, purpose and model id
		// too, so nothing derived from a record's own fields can tell them apart.
		// The admin view keys its `{#each}` on the id, and Svelte throws on a
		// duplicate key in production — taking the page down exactly when the
		// queue is busy enough to be worth looking at.
		const llama = ep('llama', 3, 'gpu0', 'llama-cpp-router');
		const comfy = ep('comfy', 3, 'gpu0');
		let resolveRelease!: () => void;
		releaseMock.mockImplementation(
			() => new Promise<boolean>((r) => (resolveRelease = () => r(true))),
		);

		// Hand the group to llama, then release — llama is now `lastHolder`, so
		// comfy's next acquire is a handover and triggers the (blocked) eviction.
		(await acquireEndpointSlot(llama, { work: { purpose: 'chat', modelId: 'gemma' } })).release();
		const evicting = acquireEndpointSlot(comfy, { work: { purpose: 'image', modelId: 'flux' } });
		await flush();
		expect(getResourceGroupSnapshot('gpu0')!.evicting).toBe(true);

		// Under capacity (1 of 3) but still blocked, so these queue rather than
		// taking the fast path — which is what sets up a multi-grant pump.
		const queued = [
			acquireEndpointSlot(comfy, { work: { purpose: 'image', modelId: 'flux' } }),
			acquireEndpointSlot(comfy, { work: { purpose: 'image', modelId: 'flux' } }),
		];
		expect(getResourceGroupSnapshot('gpu0')!.waiting).toBe(2);

		resolveRelease();
		const granted = await Promise.all([evicting, ...queued]);

		const holders = getResourceGroupSnapshot('gpu0')!.holders;
		expect(holders).toHaveLength(3);
		// The precondition: every descriptive field is identical across all three,
		// `since` included — so the id is the ONLY thing distinguishing them.
		const described = holders.map((h) => `${h.endpointId}:${h.purpose}:${h.modelId}:${h.since}`);
		expect(new Set(described).size).toBeLessThan(3);
		expect(new Set(holders.map((h) => h.id)).size).toBe(3);

		granted.forEach((g) => g.release());
	});

	it('normalizes an unlimited cap to null rather than Infinity', async () => {
		// JSON.stringify(Infinity) is `null` anyway — doing it here keeps the
		// meaning attached to the place it is still obvious.
		const slot = await acquireEndpointSlot(ep('open', Infinity), { work: { purpose: 'other' } });
		expect(getResourceGroupSnapshot('open')!.max).toBeNull();
		slot.release();
	});

	it('reports declared-but-not-queued work apart from the line, with its reason', () => {
		// The pipeline the tier exists for: a media send whose prompt is being
		// rewritten on another endpoint has not asked THIS gate for anything yet.
		const dirac = ep('dirac', 1);
		const pending = declarePendingWork(
			dirac,
			{ purpose: 'image', modelId: 'dirac::flux' },
			'enhance',
		);
		const snap = getResourceGroupSnapshot('dirac')!;
		expect(snap.pending).toHaveLength(1);
		expect(snap.pending[0]).toMatchObject({
			endpointId: 'dirac',
			purpose: 'image',
			modelId: 'dirac::flux',
			state: 'pending',
			blockedBy: 'enhance',
		});
		// Takes nothing: not a slot, not a place in line, not a waiter's position.
		expect(snap.active).toBe(0);
		expect(snap.waiting).toBe(0);
		expect(snap.holders).toEqual([]);
		expect(snap.queued).toEqual([]);
		expect(getResourceQueueDepth('dirac')).toEqual({ active: 0, waiting: 0 });

		pending.settle();
		expect(getResourceGroupSnapshot('dirac')!.pending).toEqual([]);
	});

	it('leaves `blockedBy` null on records that hold something', async () => {
		// The field is only meaningful on a pending row, and the page keys its
		// wording off it — a stray value on a holder would render "after …" on
		// something that is already running.
		const dirac = ep('dirac', 1);
		const held = await acquireEndpointSlot(dirac, { work: { purpose: 'chat' } });
		const queued = acquireEndpointSlot(dirac, { work: { purpose: 'image', modelId: 'flux' } });
		await flush();
		const snap = getResourceGroupSnapshot('dirac')!;
		expect(snap.holders[0].blockedBy).toBeNull();
		expect(snap.queued[0].blockedBy).toBeNull();
		held.release();
		(await queued).release();
	});

	it('hands a declaration over to the acquisition with no gap between them', async () => {
		// The property the whole tier rests on: a 3s poll must never catch the work
		// in neither list and report a draining batch as smaller than it is. So the
		// settle happens inside the acquire, synchronously, not at the call site.
		const dirac = ep('dirac', 1);
		const held = await acquireEndpointSlot(dirac, { work: { purpose: 'chat' } });
		const pending = declarePendingWork(dirac, { purpose: 'image', modelId: 'flux' }, 'enhance');

		const queued = acquireEndpointSlot(dirac, {
			work: { purpose: 'image', modelId: 'flux' },
			supersedes: pending,
		});
		// Read BEFORE awaiting anything: this is the same synchronous turn the
		// acquire returned in, which is the tightest a poll could ever land.
		const snap = getResourceGroupSnapshot('dirac')!;
		expect(snap.pending).toEqual([]);
		expect(snap.queued).toHaveLength(1);

		held.release();
		(await queued).release();
	});

	it('supersedes a declaration even when the acquisition is granted immediately', async () => {
		// The fast path returns before `takeSlot` awaits anything, so the settle has
		// to be keyed on the acquire returning rather than on it queueing.
		const dirac = ep('dirac', 2);
		const pending = declarePendingWork(dirac, { purpose: 'image', modelId: 'flux' }, 'enhance');
		const slot = acquireEndpointSlot(dirac, {
			work: { purpose: 'image', modelId: 'flux' },
			supersedes: pending,
		});
		const snap = getResourceGroupSnapshot('dirac')!;
		expect(snap.pending).toEqual([]);
		expect(snap.holders).toHaveLength(1);
		(await slot).release();
	});

	it('supersedes a declaration even when the acquisition is rejected outright', async () => {
		// An already-aborted acquire rejects synchronously without ever filing a
		// record. Nothing will come back for the declaration, so it must not
		// outlive the call — a pending row nobody can clear is a phantom for the
		// life of the process.
		const dirac = ep('dirac', 1);
		const pending = declarePendingWork(dirac, { purpose: 'image', modelId: 'flux' }, 'enhance');
		const ac = new AbortController();
		ac.abort();
		await expect(
			acquireEndpointSlot(dirac, {
				work: { purpose: 'image', modelId: 'flux' },
				signal: ac.signal,
				supersedes: pending,
			}),
		).rejects.toThrow();
		expect(getResourceGroupSnapshot('dirac')!.pending).toEqual([]);
	});

	it('settles a declaration exactly once across the acquire and the caller', () => {
		// Both are expected to fire: the acquire owns the happy path, the caller's
		// `finally` owns the ones that never reach it. A second settle must not
		// reach into the gate and drop somebody else's record.
		const dirac = ep('dirac', 1);
		const first = declarePendingWork(dirac, { purpose: 'image', modelId: 'a' }, 'enhance');
		const second = declarePendingWork(dirac, { purpose: 'image', modelId: 'b' }, 'enhance');
		first.settle();
		first.settle();
		expect(getResourceGroupSnapshot('dirac')!.pending.map((p) => p.modelId)).toEqual(['b']);
		second.settle();
	});

	it('frees the holder exactly once on a double release', async () => {
		const dirac = ep('dirac', 2);
		const a = await acquireEndpointSlot(dirac, { work: { purpose: 'chat', modelId: 'a' } });
		const b = await acquireEndpointSlot(dirac, { work: { purpose: 'chat', modelId: 'b' } });
		a.release();
		a.release();
		const snap = getResourceGroupSnapshot('dirac')!;
		expect(snap.active).toBe(1);
		expect(snap.holders.map((h) => h.modelId)).toEqual(['b']);
		b.release();
	});
});
