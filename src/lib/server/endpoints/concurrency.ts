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
	/** Free this slot and pump the next queued waiter. Idempotent — both a
	 *  try/finally and a relay onComplete can fire it; only the first counts. */
	release(): void;
}

export interface AcquireOptions {
	/** Aborting (client Stop / disconnect) drops a still-queued request out of
	 *  the line and rejects with an AbortError. A request that has already been
	 *  granted is unaffected — its own release frees the slot. */
	signal?: AbortSignal;
	/** Fires synchronously iff the request had to queue (capacity was full),
	 *  with its place in line. Used to emit the `queued` SSE event before the
	 *  await. Not called on the immediate-grant fast path. */
	onQueued?: (info: { position: number; ahead: number }) => void;
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

	// Slow path: enqueue. Report the queue position before pushing.
	const ahead = gate.waiters.length;
	onQueued?.({ position: ahead + 1, ahead });

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

/** Live counts for an endpoint — backs the `queued` event payload and a
 *  future diagnostics surface. Returns zeros for an endpoint never seen. */
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
