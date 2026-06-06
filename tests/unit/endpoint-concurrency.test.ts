/**
 * Unit tests for the per-endpoint concurrency gate. Pure in-memory queue
 * semantics — no real backend, no config file. Covers immediate grant under
 * capacity, FIFO ordering, release pumping exactly one waiter, release
 * idempotency, abort-while-queued (splice-out without consuming a slot),
 * abort-of-active freeing a slot, and an effectively-unlimited (Infinity) cap
 * never queuing. (The loader's default cap is finite — see endpoints-config.)
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	acquireEndpointSlot,
	getEndpointQueueDepth,
	resetEndpointGatesForTests,
} from '$lib/server/endpoints/concurrency';

afterEach(() => {
	resetEndpointGatesForTests();
});

/** A promise that resolves on the next microtask — lets a queued waiter's
 *  grant settle before we assert. */
const flush = () => Promise.resolve();

describe('acquireEndpointSlot', () => {
	it('grants immediately when under capacity', async () => {
		const slot = await acquireEndpointSlot('ep', 2);
		expect(getEndpointQueueDepth('ep')).toEqual({ active: 1, waiting: 0 });
		slot.release();
		expect(getEndpointQueueDepth('ep')).toEqual({ active: 0, waiting: 0 });
	});

	it('queues once at capacity and fires onQueued with the count ahead', async () => {
		const a = await acquireEndpointSlot('ep', 1);
		const onQueued = vi.fn();
		let granted = false;
		const pending = acquireEndpointSlot('ep', 1, { onQueued }).then((s) => {
			granted = true;
			return s;
		});

		await flush();
		expect(granted).toBe(false);
		expect(onQueued).toHaveBeenCalledWith({ ahead: 0 });
		expect(getEndpointQueueDepth('ep')).toEqual({ active: 1, waiting: 1 });

		a.release();
		const b = await pending;
		expect(granted).toBe(true);
		expect(getEndpointQueueDepth('ep')).toEqual({ active: 1, waiting: 0 });
		b.release();
	});

	it('does not call onQueued on the immediate-grant fast path', async () => {
		const onQueued = vi.fn();
		const slot = await acquireEndpointSlot('ep', 2, { onQueued });
		expect(onQueued).not.toHaveBeenCalled();
		slot.release();
	});

	it('grants queued waiters in FIFO order', async () => {
		const a = await acquireEndpointSlot('ep', 1);
		const order: number[] = [];
		const queued1 = vi.fn();
		const queued2 = vi.fn();
		const p1 = acquireEndpointSlot('ep', 1, { onQueued: queued1 }).then((s) => {
			order.push(1);
			return s;
		});
		const p2 = acquireEndpointSlot('ep', 1, { onQueued: queued2 }).then((s) => {
			order.push(2);
			return s;
		});

		await flush();
		// Second waiter sees one ahead of it.
		expect(queued1).toHaveBeenCalledWith({ ahead: 0 });
		expect(queued2).toHaveBeenCalledWith({ ahead: 1 });
		expect(getEndpointQueueDepth('ep')).toEqual({ active: 1, waiting: 2 });

		a.release();
		const s1 = await p1;
		expect(order).toEqual([1]);
		s1.release();
		const s2 = await p2;
		expect(order).toEqual([1, 2]);
		s2.release();
	});

	it('release pumps exactly one waiter, not all', async () => {
		const a = await acquireEndpointSlot('ep', 1);
		let g1 = false;
		let g2 = false;
		const p1 = acquireEndpointSlot('ep', 1).then((s) => {
			g1 = true;
			return s;
		});
		const p2 = acquireEndpointSlot('ep', 1).then((s) => {
			g2 = true;
			return s;
		});
		await flush();

		a.release();
		const s1 = await p1;
		expect(g1).toBe(true);
		expect(g2).toBe(false); // still queued — only one slot freed
		expect(getEndpointQueueDepth('ep')).toEqual({ active: 1, waiting: 1 });

		s1.release();
		await p2;
		expect(g2).toBe(true);
		(await p2).release();
	});

	it('release is idempotent — a double release frees only one slot', async () => {
		const a = await acquireEndpointSlot('ep', 2);
		const b = await acquireEndpointSlot('ep', 2);
		expect(getEndpointQueueDepth('ep')).toEqual({ active: 2, waiting: 0 });

		a.release();
		a.release(); // no-op
		expect(getEndpointQueueDepth('ep')).toEqual({ active: 1, waiting: 0 });
		b.release();
		expect(getEndpointQueueDepth('ep')).toEqual({ active: 0, waiting: 0 });
	});

	it('Infinity capacity never queues', async () => {
		const onQueued = vi.fn();
		const slots = await Promise.all(
			Array.from({ length: 50 }, () => acquireEndpointSlot('ep', Infinity, { onQueued })),
		);
		expect(onQueued).not.toHaveBeenCalled();
		expect(getEndpointQueueDepth('ep')).toEqual({ active: 50, waiting: 0 });
		for (const s of slots) s.release();
	});

	describe('abort', () => {
		it('rejects synchronously when the signal is already aborted', async () => {
			const slot = await acquireEndpointSlot('ep', 1); // fill capacity
			const controller = new AbortController();
			controller.abort();
			await expect(
				acquireEndpointSlot('ep', 1, { signal: controller.signal }),
			).rejects.toMatchObject({ name: 'AbortError' });
			// The aborted attempt never entered the queue or took a slot.
			expect(getEndpointQueueDepth('ep')).toEqual({ active: 1, waiting: 0 });
			slot.release();
		});

		it('drops a queued waiter out of line without consuming a slot', async () => {
			const a = await acquireEndpointSlot('ep', 1);
			const controller = new AbortController();
			const pending = acquireEndpointSlot('ep', 1, { signal: controller.signal });
			await flush();
			expect(getEndpointQueueDepth('ep')).toEqual({ active: 1, waiting: 1 });

			controller.abort();
			await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
			expect(getEndpointQueueDepth('ep')).toEqual({ active: 1, waiting: 0 });

			// Releasing the active slot must NOT try to grant the aborted waiter.
			a.release();
			expect(getEndpointQueueDepth('ep')).toEqual({ active: 0, waiting: 0 });
		});

		it('aborting one queued waiter still grants the next in line', async () => {
			const a = await acquireEndpointSlot('ep', 1);
			const c1 = new AbortController();
			const p1 = acquireEndpointSlot('ep', 1, { signal: c1.signal });
			let g2 = false;
			const p2 = acquireEndpointSlot('ep', 1).then((s) => {
				g2 = true;
				return s;
			});
			await flush();

			c1.abort();
			await expect(p1).rejects.toMatchObject({ name: 'AbortError' });
			expect(getEndpointQueueDepth('ep')).toEqual({ active: 1, waiting: 1 });

			a.release();
			await p2;
			expect(g2).toBe(true);
			(await p2).release();
		});

		it('a granted slot is unaffected by a later abort of its signal', async () => {
			const controller = new AbortController();
			const slot = await acquireEndpointSlot('ep', 1, { signal: controller.signal });
			expect(getEndpointQueueDepth('ep')).toEqual({ active: 1, waiting: 0 });
			// Abort after grant — must not corrupt active count or throw.
			controller.abort();
			expect(getEndpointQueueDepth('ep')).toEqual({ active: 1, waiting: 0 });
			slot.release();
			expect(getEndpointQueueDepth('ep')).toEqual({ active: 0, waiting: 0 });
		});
	});

	it('isolates queues per endpoint id', async () => {
		const a = await acquireEndpointSlot('ep-a', 1);
		const b = await acquireEndpointSlot('ep-b', 1); // different endpoint, immediate
		expect(getEndpointQueueDepth('ep-a')).toEqual({ active: 1, waiting: 0 });
		expect(getEndpointQueueDepth('ep-b')).toEqual({ active: 1, waiting: 0 });
		a.release();
		b.release();
	});
});
