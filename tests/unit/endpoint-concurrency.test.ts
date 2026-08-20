/**
 * Unit tests for the per-endpoint concurrency gate. Pure in-memory queue
 * semantics — no real backend, no config file. Covers immediate grant under
 * capacity, FIFO ordering, release pumping exactly one waiter, release
 * idempotency, abort-while-queued (splice-out without consuming a slot),
 * abort-of-active freeing a slot, and an effectively-unlimited (Infinity) cap
 * never queuing. (The loader's default cap is finite — see endpoints-config.)
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// The gate calls this when a group changes hands; stubbing it lets the ordering
// be observed without a backend, and lets a slow release be simulated.
const releaseMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('$lib/server/endpoints/release', () => ({ releaseEndpointResources: releaseMock }));
import {
	acquireEndpointSlot,
	getResourceQueueDepth,
	resetEndpointGatesForTests,
} from '$lib/server/endpoints/concurrency';
import type { LoadedEndpoint } from '$lib/server/endpoints/config';

/** The gate reads only the group key and its cap, so the rest is filler.
 *  `group` defaults to the id — what the loader resolves for an endpoint that
 *  didn't opt into a resource group. */
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
	releaseMock.mockImplementation(async () => {});
});

/** A promise that resolves on the next microtask — lets a queued waiter's
 *  grant settle before we assert. */
const flush = () => Promise.resolve();

describe('acquireEndpointSlot', () => {
	it('grants immediately when under capacity', async () => {
		const slot = await acquireEndpointSlot(ep('ep', 2));
		expect(getResourceQueueDepth('ep')).toEqual({ active: 1, waiting: 0 });
		slot.release();
		expect(getResourceQueueDepth('ep')).toEqual({ active: 0, waiting: 0 });
	});

	it('queues once at capacity and fires onQueued with the count ahead', async () => {
		const a = await acquireEndpointSlot(ep('ep', 1));
		const onQueued = vi.fn();
		let granted = false;
		const pending = acquireEndpointSlot(ep('ep', 1), { onQueued }).then((s) => {
			granted = true;
			return s;
		});

		await flush();
		expect(granted).toBe(false);
		expect(onQueued).toHaveBeenCalledWith({ ahead: 0 });
		expect(getResourceQueueDepth('ep')).toEqual({ active: 1, waiting: 1 });

		a.release();
		const b = await pending;
		expect(granted).toBe(true);
		expect(getResourceQueueDepth('ep')).toEqual({ active: 1, waiting: 0 });
		b.release();
	});

	it('does not call onQueued on the immediate-grant fast path', async () => {
		const onQueued = vi.fn();
		const slot = await acquireEndpointSlot(ep('ep', 2), { onQueued });
		expect(onQueued).not.toHaveBeenCalled();
		slot.release();
	});

	it('grants queued waiters in FIFO order', async () => {
		const a = await acquireEndpointSlot(ep('ep', 1));
		const order: number[] = [];
		const queued1 = vi.fn();
		const queued2 = vi.fn();
		const p1 = acquireEndpointSlot(ep('ep', 1), { onQueued: queued1 }).then((s) => {
			order.push(1);
			return s;
		});
		const p2 = acquireEndpointSlot(ep('ep', 1), { onQueued: queued2 }).then((s) => {
			order.push(2);
			return s;
		});

		await flush();
		// Second waiter sees one ahead of it.
		expect(queued1).toHaveBeenCalledWith({ ahead: 0 });
		expect(queued2).toHaveBeenCalledWith({ ahead: 1 });
		expect(getResourceQueueDepth('ep')).toEqual({ active: 1, waiting: 2 });

		a.release();
		const s1 = await p1;
		expect(order).toEqual([1]);
		s1.release();
		const s2 = await p2;
		expect(order).toEqual([1, 2]);
		s2.release();
	});

	it('re-fires onQueued with a decremented count as the line drains', async () => {
		// One active, three queued behind it (ahead 0, 1, 2). As each active
		// generation finishes, the remaining waiters move up and must be told.
		const active = await acquireEndpointSlot(ep('ep', 1));
		const q0 = vi.fn();
		const q1 = vi.fn();
		const q2 = vi.fn();
		const p0 = acquireEndpointSlot(ep('ep', 1), { onQueued: q0 });
		const p1 = acquireEndpointSlot(ep('ep', 1), { onQueued: q1 });
		const p2 = acquireEndpointSlot(ep('ep', 1), { onQueued: q2 });
		await flush();

		// Initial positions at enqueue.
		expect(q0).toHaveBeenLastCalledWith({ ahead: 0 });
		expect(q1).toHaveBeenLastCalledWith({ ahead: 1 });
		expect(q2).toHaveBeenLastCalledWith({ ahead: 2 });

		// First generation finishes → q0 is granted; q1 and q2 each move up one.
		active.release();
		const s0 = await p0;
		expect(q1).toHaveBeenLastCalledWith({ ahead: 0 });
		expect(q2).toHaveBeenLastCalledWith({ ahead: 1 });
		// The granted waiter is no longer re-notified.
		expect(q0).toHaveBeenCalledTimes(1);

		// Next finishes → q1 granted, q2 reaches the front (0 ahead).
		s0.release();
		const s1 = await p1;
		expect(q2).toHaveBeenLastCalledWith({ ahead: 0 });

		s1.release();
		(await p2).release();
	});

	it('does not re-fire onQueued on a release that grants no one', async () => {
		// Two slots, two active, one queued. Releasing one active frees a slot the
		// queued waiter takes — but a SECOND queued waiter mustn't be spuriously
		// re-notified when nothing further is granted.
		const a = await acquireEndpointSlot(ep('ep', 2));
		const b = await acquireEndpointSlot(ep('ep', 2));
		const q = vi.fn();
		const pq = acquireEndpointSlot(ep('ep', 2), { onQueued: q });
		await flush();
		expect(q).toHaveBeenCalledTimes(1); // initial enqueue only

		a.release(); // grants the queued waiter; no one left in line to re-notify
		const sq = await pq;
		expect(q).toHaveBeenCalledTimes(1);
		b.release();
		sq.release();
	});

	it('refreshes positions when a queued waiter aborts out of the middle', async () => {
		const active = await acquireEndpointSlot(ep('ep', 1));
		const c1 = new AbortController();
		const q0 = vi.fn();
		const q1 = vi.fn();
		const q2 = vi.fn();
		const p0 = acquireEndpointSlot(ep('ep', 1), { onQueued: q0 });
		const p1 = acquireEndpointSlot(ep('ep', 1), { signal: c1.signal, onQueued: q1 });
		const p2 = acquireEndpointSlot(ep('ep', 1), { onQueued: q2 });
		await flush();
		expect(q2).toHaveBeenLastCalledWith({ ahead: 2 });

		// Abort the middle waiter — the one behind it moves up to 1 ahead.
		c1.abort();
		await expect(p1).rejects.toMatchObject({ name: 'AbortError' });
		expect(q2).toHaveBeenLastCalledWith({ ahead: 1 });

		active.release();
		const s0 = await p0;
		s0.release();
		(await p2).release();
	});

	it('release pumps exactly one waiter, not all', async () => {
		const a = await acquireEndpointSlot(ep('ep', 1));
		let g1 = false;
		let g2 = false;
		const p1 = acquireEndpointSlot(ep('ep', 1)).then((s) => {
			g1 = true;
			return s;
		});
		const p2 = acquireEndpointSlot(ep('ep', 1)).then((s) => {
			g2 = true;
			return s;
		});
		await flush();

		a.release();
		const s1 = await p1;
		expect(g1).toBe(true);
		expect(g2).toBe(false); // still queued — only one slot freed
		expect(getResourceQueueDepth('ep')).toEqual({ active: 1, waiting: 1 });

		s1.release();
		await p2;
		expect(g2).toBe(true);
		(await p2).release();
	});

	it('release is idempotent — a double release frees only one slot', async () => {
		const a = await acquireEndpointSlot(ep('ep', 2));
		const b = await acquireEndpointSlot(ep('ep', 2));
		expect(getResourceQueueDepth('ep')).toEqual({ active: 2, waiting: 0 });

		a.release();
		a.release(); // no-op
		expect(getResourceQueueDepth('ep')).toEqual({ active: 1, waiting: 0 });
		b.release();
		expect(getResourceQueueDepth('ep')).toEqual({ active: 0, waiting: 0 });
	});

	it('Infinity capacity never queues', async () => {
		const onQueued = vi.fn();
		const slots = await Promise.all(
			Array.from({ length: 50 }, () => acquireEndpointSlot(ep('ep', Infinity), { onQueued })),
		);
		expect(onQueued).not.toHaveBeenCalled();
		expect(getResourceQueueDepth('ep')).toEqual({ active: 50, waiting: 0 });
		for (const s of slots) s.release();
	});

	describe('abort', () => {
		it('rejects synchronously when the signal is already aborted', async () => {
			const slot = await acquireEndpointSlot(ep('ep', 1)); // fill capacity
			const controller = new AbortController();
			controller.abort();
			await expect(
				acquireEndpointSlot(ep('ep', 1), { signal: controller.signal }),
			).rejects.toMatchObject({ name: 'AbortError' });
			// The aborted attempt never entered the queue or took a slot.
			expect(getResourceQueueDepth('ep')).toEqual({ active: 1, waiting: 0 });
			slot.release();
		});

		it('drops a queued waiter out of line without consuming a slot', async () => {
			const a = await acquireEndpointSlot(ep('ep', 1));
			const controller = new AbortController();
			const pending = acquireEndpointSlot(ep('ep', 1), { signal: controller.signal });
			await flush();
			expect(getResourceQueueDepth('ep')).toEqual({ active: 1, waiting: 1 });

			controller.abort();
			await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
			expect(getResourceQueueDepth('ep')).toEqual({ active: 1, waiting: 0 });

			// Releasing the active slot must NOT try to grant the aborted waiter.
			a.release();
			expect(getResourceQueueDepth('ep')).toEqual({ active: 0, waiting: 0 });
		});

		it('aborting one queued waiter still grants the next in line', async () => {
			const a = await acquireEndpointSlot(ep('ep', 1));
			const c1 = new AbortController();
			const p1 = acquireEndpointSlot(ep('ep', 1), { signal: c1.signal });
			let g2 = false;
			const p2 = acquireEndpointSlot(ep('ep', 1)).then((s) => {
				g2 = true;
				return s;
			});
			await flush();

			c1.abort();
			await expect(p1).rejects.toMatchObject({ name: 'AbortError' });
			expect(getResourceQueueDepth('ep')).toEqual({ active: 1, waiting: 1 });

			a.release();
			await p2;
			expect(g2).toBe(true);
			(await p2).release();
		});

		it('a granted slot is unaffected by a later abort of its signal', async () => {
			const controller = new AbortController();
			const slot = await acquireEndpointSlot(ep('ep', 1), { signal: controller.signal });
			expect(getResourceQueueDepth('ep')).toEqual({ active: 1, waiting: 0 });
			// Abort after grant — must not corrupt active count or throw.
			controller.abort();
			expect(getResourceQueueDepth('ep')).toEqual({ active: 1, waiting: 0 });
			slot.release();
			expect(getResourceQueueDepth('ep')).toEqual({ active: 0, waiting: 0 });
		});
	});

	it('isolates queues per endpoint id', async () => {
		const a = await acquireEndpointSlot(ep('ep-a', 1));
		const b = await acquireEndpointSlot(ep('ep-b', 1)); // different endpoint, immediate
		expect(getResourceQueueDepth('ep-a')).toEqual({ active: 1, waiting: 0 });
		expect(getResourceQueueDepth('ep-b')).toEqual({ active: 1, waiting: 0 });
		a.release();
		b.release();
	});
});

describe('resource groups', () => {
	it('serializes two DIFFERENT endpoints that name the same group', async () => {
		// The reason the feature exists: a llama.cpp endpoint and a
		// ComfyUI-bridging endpoint on one GPU. Their own gates each serialize
		// correctly and know nothing of each other, so without a shared group a
		// chat turn and an image generation collide over the same VRAM.
		const llama = ep('llama', 1, 'gpu0');
		const bridge = ep('bridge', 1, 'gpu0');

		const held = await acquireEndpointSlot(llama);
		let granted = false;
		const pending = acquireEndpointSlot(bridge).then((s) => {
			granted = true;
			return s;
		});

		await flush();
		expect(granted).toBe(false);
		expect(getResourceQueueDepth('gpu0')).toEqual({ active: 1, waiting: 1 });

		held.release();
		(await pending).release();
		expect(getResourceQueueDepth('gpu0')).toEqual({ active: 0, waiting: 0 });
	});

	it('leaves ungrouped endpoints independent, as before', async () => {
		// The default group is the endpoint's own id, so an install that never
		// heard of resource groups behaves exactly as it did.
		const a = await acquireEndpointSlot(ep('a', 1));
		const b = await acquireEndpointSlot(ep('b', 1));
		expect(getResourceQueueDepth('a')).toEqual({ active: 1, waiting: 0 });
		expect(getResourceQueueDepth('b')).toEqual({ active: 1, waiting: 0 });
		a.release();
		b.release();
	});

	it('counts queue position across the group, not per endpoint', async () => {
		// What the user sees as "Queued — N ahead" has to count the whole shared
		// resource, or the number is a lie whenever the contention is the other
		// endpoint's. `ahead` counts waiters in front of you, so the first
		// queuer sees 0 even though the resource is busy.
		const held = await acquireEndpointSlot(ep('llama', 1, 'gpu0'));
		const firstQueued = vi.fn();
		const secondQueued = vi.fn();

		const first = acquireEndpointSlot(ep('bridge', 1, 'gpu0'), { onQueued: firstQueued });
		const second = acquireEndpointSlot(ep('llama', 1, 'gpu0'), { onQueued: secondQueued });
		await flush();

		expect(firstQueued).toHaveBeenCalledWith({ ahead: 0 });
		// The one it's behind is on the OTHER endpoint — the number only comes
		// out right because both share the group's single line.
		expect(secondQueued).toHaveBeenCalledWith({ ahead: 1 });

		held.release();
		(await first).release();
		(await second).release();
	});
});

describe('freeing a shared resource on handover', () => {
	it('frees the previous holder before granting to a different member', async () => {
		// The case the whole mechanism exists for: llama.cpp finished its turn and
		// is sitting on the VRAM, and ComfyUI is next.
		const llama = ep('llama', 1, 'gpu0', 'llama-cpp-router');
		const bridge = ep('bridge', 1, 'gpu0');

		(await acquireEndpointSlot(llama)).release();
		expect(releaseMock).not.toHaveBeenCalled();

		const slot = await acquireEndpointSlot(bridge);
		expect(releaseMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'llama' }), undefined);
		slot.release();
	});

	it('does NOT free when the same endpoint takes the slot again', async () => {
		// Otherwise every consecutive chat turn pays a full model reload, which on
		// a large model is most of the wall clock.
		const llama = ep('llama', 1, 'gpu0', 'llama-cpp-router');
		(await acquireEndpointSlot(llama)).release();
		(await acquireEndpointSlot(llama)).release();
		expect(releaseMock).not.toHaveBeenCalled();
	});

	it('does nothing for an endpoint with no release strategy', async () => {
		const a = ep('a', 1, 'gpu0');
		const b = ep('b', 1, 'gpu0');
		(await acquireEndpointSlot(a)).release();
		(await acquireEndpointSlot(b)).release();
		expect(releaseMock).not.toHaveBeenCalled();
	});

	it('frees before a QUEUED waiter from another member is granted', async () => {
		// The handover often happens through the queue, not the fast path, and a
		// waiter must not start generating until the resource is actually free.
		const llama = ep('llama', 1, 'gpu0', 'llama-cpp-router');
		const bridge = ep('bridge', 1, 'gpu0');
		let freed = false;
		releaseMock.mockImplementation(async () => {
			await Promise.resolve();
			freed = true;
		});

		const held = await acquireEndpointSlot(llama);
		let grantedBeforeFree: boolean | null = null;
		const pending = acquireEndpointSlot(bridge).then((s) => {
			grantedBeforeFree = !freed;
			return s;
		});

		held.release();
		(await pending).release();
		expect(releaseMock).toHaveBeenCalledOnce();
		expect(grantedBeforeFree).toBe(false);
	});

	it('holds the slot while freeing, so nobody slips in', async () => {
		// The slot is taken before the (awaited) release, so a concurrent acquire
		// queues rather than starting a generation onto a GPU mid-eviction.
		const llama = ep('llama', 1, 'gpu0', 'llama-cpp-router');
		const bridge = ep('bridge', 1, 'gpu0');
		let resolveRelease!: () => void;
		releaseMock.mockImplementation(() => new Promise<void>((r) => (resolveRelease = r)));

		(await acquireEndpointSlot(llama)).release();
		const first = acquireEndpointSlot(bridge);
		await flush();

		// Mid-release: the slot is already accounted for.
		expect(getResourceQueueDepth('gpu0')).toEqual({ active: 1, waiting: 0 });
		let secondGranted = false;
		const second = acquireEndpointSlot(bridge).then((s) => {
			secondGranted = true;
			return s;
		});
		await flush();
		expect(secondGranted).toBe(false);

		resolveRelease();
		(await first).release();
		(await second).release();
	});

	it('leaves an idle group alone until someone else actually wants it', async () => {
		// Releasing eagerly when a turn finishes would evict a model the next
		// request probably wants — the release is tied to the handover, not to
		// going idle.
		const llama = ep('llama', 1, 'gpu0', 'llama-cpp-router');
		(await acquireEndpointSlot(llama)).release();
		await flush();
		expect(releaseMock).not.toHaveBeenCalled();
	});
});
