/**
 * Per-resource concurrency gate.
 *
 * A generation against an endpoint must `acquireEndpointSlot` before it
 * touches the upstream, and `release` when it fully settles. While `active`
 * slots are below the endpoint's `max_concurrent`, acquisition is immediate;
 * once at capacity, callers queue FIFO and are granted as slots free.
 *
 * The slot is held for the WHOLE generation (acquire before dispatch,
 * release in the relay's onComplete / the sync path's finally), not just the
 * HTTP POST — so a single-GPU local backend that can only hold one model in
 * VRAM serializes instead of thrashing. An unconfigured endpoint defaults to
 * `DEFAULT_MAX_CONCURRENT` (4) — a friendly cap so a large multi-model fan-out
 * trickles rather than blasting the upstream. `max = Infinity` (which an
 * operator can approximate with a high `max_concurrent`) makes the fast path
 * always win, turning the gate into a zero-overhead pass-through.
 *
 * Keyed by RESOURCE GROUP (a string), which defaults to the endpoint's id. A
 * single backend that hot-swaps models still shares one VRAM pool, so the gate
 * is intentionally endpoint-wide rather than per-(endpoint, model) — and by the
 * same reasoning, two endpoints on one GPU (a llama.cpp server and a
 * ComfyUI-bridging endpoint, say) share one gate when the operator names them
 * as one `resource_group`. Serializing is all this does: it stops them running
 * at once, but cannot make one of them release VRAM it is merely holding.
 *
 * Module-level state is fine for a single Node process; multi-replica
 * deployments would need a shared store, which is a v2 concern (same caveat
 * as the in-flight registry).
 */

import type { LoadedEndpoint } from './config';
import { releaseEndpointResources } from './release';

interface Waiter {
	/** Grant the slot — resolves the caller's pending promise. */
	grant: () => void;
	reject: (err: Error) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
	/** Re-report this waiter's current position as the line drains, so the
	 *  client's "N ahead" counts down (not just at enqueue). Same channel as the
	 *  initial onQueued. */
	notifyAhead?: (ahead: number) => void;
	/** Who is waiting — the grant needs it to decide whether taking the slot is
	 *  a handover between different members of the group. */
	endpoint: LoadedEndpoint;
}

interface Gate {
	active: number;
	max: number;
	waiters: Waiter[];
	/**
	 * The last member of this group to be granted a slot. Kept after release so
	 * a handover can be recognised while the group sits idle — which is exactly
	 * when it matters, since the resident model that needs evicting is held by
	 * an endpoint that has already finished.
	 */
	lastHolder: LoadedEndpoint | null;
}

const gates = new Map<string, Gate>();

function getGate(resourceGroup: string, max: number): Gate {
	const existing = gates.get(resourceGroup);
	if (existing) {
		// Reflect the latest configured cap (config could have reloaded).
		existing.max = max;
		return existing;
	}
	const gate: Gate = { active: 0, max, waiters: [], lastHolder: null };
	gates.set(resourceGroup, gate);
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
	/** Fires when the request had to queue (capacity was full): once
	 *  synchronously with the initial count ahead, then again with the updated
	 *  count each time the line drains in front of it — so the `queued` SSE event
	 *  it emits lets the client count "N ahead" down. Not called on the
	 *  immediate-grant fast path. */
	onQueued?: (info: { ahead: number }) => void;
}

/**
 * Take the slot for `endpoint`, freeing the previous holder's resource first
 * when this is a handover between different members of the group.
 *
 * Three conditions, all necessary:
 *  - the group is otherwise IDLE (`active === 1` — the caller's own increment).
 *    With a cap above 1 another member could still be generating, and evicting
 *    a model out from under it is worse than the contention we're avoiding.
 *  - the previous holder is a DIFFERENT endpoint. Handing the slot back to the
 *    same one must not evict; otherwise every turn pays a full model reload,
 *    which on a large model is most of the wall clock.
 *  - that endpoint knows how to let go. Most don't need to — ComfyUI already
 *    unloads after each generation — and `release: null` keeps this a no-op.
 *
 * Done on GRANT rather than on release: releasing eagerly when a generation
 * finishes would evict a model the very next request probably wants.
 */
async function takeSlot(gate: Gate, endpoint: LoadedEndpoint, signal?: AbortSignal) {
	const previous = gate.lastHolder;
	gate.lastHolder = endpoint;
	if (gate.active === 1 && previous && previous.id !== endpoint.id && previous.release) {
		await releaseEndpointResources(previous, signal);
	}
	return makeSlot(gate);
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
	let granted = 0;
	while (gate.active < gate.max && gate.waiters.length > 0) {
		const waiter = gate.waiters.shift()!;
		if (waiter.signal && waiter.onAbort) {
			waiter.signal.removeEventListener('abort', waiter.onAbort);
		}
		gate.active++;
		granted++;
		waiter.grant();
	}
	// Granting shifts waiters off the front, so everyone still in line just moved
	// up — re-report their new positions so a queued branch's "N ahead" counts
	// down as the line drains. Skip when nothing was granted (positions unchanged).
	if (granted > 0) notifyWaiterPositions(gate);
}

/** Re-emit each still-queued waiter's current position (its index = how many are
 *  ahead of it). Called whenever the line shifts — a grant pumps the front off,
 *  or an abort splices one out — so a waiting caller's "N ahead" stays live. */
function notifyWaiterPositions(gate: Gate): void {
	for (let i = 0; i < gate.waiters.length; i++) {
		gate.waiters[i].notifyAhead?.(i);
	}
}

function abortError(): Error {
	return new DOMException('Endpoint slot acquisition aborted', 'AbortError');
}

/**
 * Acquire a slot on the endpoint's resource group, capped at that group's
 * concurrency. Resolves
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
	endpoint: LoadedEndpoint,
	opts: AcquireOptions = {},
): Promise<EndpointSlot> {
	const { signal, onQueued } = opts;
	// Keyed by RESOURCE GROUP, not endpoint id — which for an endpoint that
	// didn't opt into a group are the same string, so this is the previous
	// behaviour exactly. Taking the endpoint rather than `(id, max)` is
	// deliberate: passing the id by hand is how a caller would silently opt out
	// of its own group, and the two values have to come from the same place to
	// stay consistent.
	const gate = getGate(endpoint.resourceGroup, endpoint.resourceGroupMaxConcurrent);

	if (signal?.aborted) return Promise.reject(abortError());

	// Fast path: capacity available (always true for an effectively-unlimited max).
	if (gate.active < gate.max) {
		// Increment BEFORE any await in `takeSlot`: the slot is ours from this
		// moment, so a concurrent acquire queues behind us rather than slipping in
		// while we're freeing the resource.
		gate.active++;
		return takeSlot(gate, endpoint, signal);
	}

	// Slow path: enqueue. Report how many are already waiting before pushing.
	const ahead = gate.waiters.length;
	onQueued?.({ ahead });

	return new Promise<EndpointSlot>((resolve, reject) => {
		const waiter: Waiter = {
			// `resolve` adopts the promise, so a waiter granted during a handover
			// stays pending until the previous holder has actually let go.
			grant: () => resolve(takeSlot(gate, endpoint, signal)),
			reject,
			// Re-emit position as the line drains so the client's "N ahead" counts
			// down. Routes through the same onQueued → `queued` SSE channel.
			notifyAhead: onQueued ? (ahead) => onQueued({ ahead }) : undefined,
			endpoint,
		};
		if (signal) {
			const onAbort = () => {
				const idx = gate.waiters.indexOf(waiter);
				if (idx === -1) return; // already granted — nothing to drop
				gate.waiters.splice(idx, 1);
				reject(abortError());
				// Those behind the dropped waiter moved up — refresh their positions.
				notifyWaiterPositions(gate);
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
export function getResourceQueueDepth(resourceGroup: string): { active: number; waiting: number } {
	const gate = gates.get(resourceGroup);
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
