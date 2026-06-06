/**
 * Per-endpoint concurrency gate.
 *
 * A generation against an endpoint must `acquireEndpointSlot` before it
 * touches the upstream, and `release` when it fully settles. While `active`
 * slots are below the endpoint's `max_concurrent`, acquisition is immediate;
 * once at capacity, callers queue FIFO and are granted as slots free.
 *
 * The slot is held for the WHOLE generation (acquire before dispatch,
 * release in the relay's onComplete / the sync path's finally), not just the
 * HTTP POST — so a single-GPU local backend that can only hold one model in
 * VRAM serializes instead of thrashing. `max = Infinity` (the default for an
 * endpoint with no `max_concurrent`) makes the fast path always win, so the
 * gate is a zero-overhead pass-through for unconfigured endpoints.
 *
 * Keyed by endpoint id (string). A single backend that hot-swaps models
 * still shares one VRAM pool, so the gate is intentionally endpoint-wide
 * rather than per-(endpoint, model) — see ROADMAP / the Multi-model plan.
 *
 * Module-level state is fine for a single Node process; multi-replica
 * deployments would need a shared store, which is a v2 concern (same caveat
 * as the in-flight registry).
 */

interface Waiter {
	/** Grant the slot — resolves the caller's pending promise. */
	grant: () => void;
	reject: (err: Error) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
}

interface Gate {
	active: number;
	max: number;
	waiters: Waiter[];
}

const gates = new Map<string, Gate>();

function getGate(endpointId: string, max: number): Gate {
	const existing = gates.get(endpointId);
	if (existing) {
		// Reflect the latest configured cap (config could have reloaded).
		existing.max = max;
		return existing;
	}
	const gate: Gate = { active: 0, max, waiters: [] };
	gates.set(endpointId, gate);
	return gate;
}

export interface EndpointSlot {
	/** Free this slot and pump the next queued waiter. Idempotent: a caller
	 *  that releases the same slot from more than one cleanup path (e.g. both
	 *  explicitly and from a finally) frees it exactly once. */
	release(): void;
}

export interface AcquireOptions {
	/** Aborting (client Stop / disconnect) drops a still-queued request out of
	 *  the line and rejects with an AbortError. A request that has already been
	 *  granted is unaffected — its own release frees the slot. */
	signal?: AbortSignal;
	/** Fires synchronously iff the request had to queue (capacity was full),
	 *  with how many generations are ahead of it. Used to emit the `queued`
	 *  SSE event before the await. Not called on the immediate-grant fast path. */
	onQueued?: (info: { ahead: number }) => void;
}

function makeSlot(gate: Gate): EndpointSlot {
	let released = false;
	return {
		release() {
			if (released) return;
			released = true;
			gate.active--;
			pump(gate);
		},
	};
}

function pump(gate: Gate): void {
	while (gate.active < gate.max && gate.waiters.length > 0) {
		const waiter = gate.waiters.shift()!;
		if (waiter.signal && waiter.onAbort) {
			waiter.signal.removeEventListener('abort', waiter.onAbort);
		}
		gate.active++;
		waiter.grant();
	}
}

function abortError(): Error {
	return new DOMException('Endpoint slot acquisition aborted', 'AbortError');
}

/**
 * Acquire a slot on `endpointId`, capped at `max` concurrent. Resolves
 * immediately when under capacity, otherwise queues FIFO and resolves once a
 * slot frees. Pass `endpoint.maxConcurrent` for `max`.
 *
 * If `opts.signal` aborts before the slot is granted, the returned promise
 * rejects with an `AbortError` and the request leaves the queue without ever
 * taking a slot. Each integration point folds that rejection into whatever
 * cancellation it already does — deliberately not unified, because each
 * medium cancels differently and should stay consistent with its own
 * non-gate Stop path: the chat relay closes the SSE silently, the video
 * relay emits a `Cancelled` error event, and the sync image path throws
 * HTTP 499. A new caller should pick the matching option for its medium.
 */
export function acquireEndpointSlot(
	endpointId: string,
	max: number,
	opts: AcquireOptions = {},
): Promise<EndpointSlot> {
	const { signal, onQueued } = opts;
	const gate = getGate(endpointId, max);

	if (signal?.aborted) return Promise.reject(abortError());

	// Fast path: capacity available (always true when max === Infinity).
	if (gate.active < gate.max) {
		gate.active++;
		return Promise.resolve(makeSlot(gate));
	}

	// Slow path: enqueue. Report how many are already waiting before pushing.
	const ahead = gate.waiters.length;
	onQueued?.({ ahead });

	return new Promise<EndpointSlot>((resolve, reject) => {
		const waiter: Waiter = {
			grant: () => resolve(makeSlot(gate)),
			reject,
		};
		if (signal) {
			const onAbort = () => {
				const idx = gate.waiters.indexOf(waiter);
				if (idx === -1) return; // already granted — nothing to drop
				gate.waiters.splice(idx, 1);
				reject(abortError());
			};
			waiter.signal = signal;
			waiter.onAbort = onAbort;
			signal.addEventListener('abort', onAbort);
		}
		gate.waiters.push(waiter);
	});
}

/** Live counts for an endpoint — a future diagnostics surface (and the
 *  test seam for the queue semantics). The `queued` event's `ahead` value is
 *  computed inline in acquireEndpointSlot, not from this. Returns zeros for an
 *  endpoint never seen. */
export function getEndpointQueueDepth(endpointId: string): { active: number; waiting: number } {
	const gate = gates.get(endpointId);
	if (!gate) return { active: 0, waiting: 0 };
	return { active: gate.active, waiting: gate.waiters.length };
}

/** Test-only: reject every queued waiter and clear all gate state. */
export function resetEndpointGatesForTests(): void {
	for (const gate of gates.values()) {
		for (const waiter of gate.waiters) {
			if (waiter.signal && waiter.onAbort) {
				waiter.signal.removeEventListener('abort', waiter.onAbort);
			}
			waiter.reject(new Error('endpoint gate reset'));
		}
		gate.waiters = [];
		gate.active = 0;
	}
	gates.clear();
}
