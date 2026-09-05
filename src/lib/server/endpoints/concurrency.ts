/**
 * Per-resource concurrency gate.
 *
 * A generation against an endpoint must `acquireEndpointSlot` before it
 * touches the upstream, and `release` when it fully settles. While `active`
 * slots are below the resource group's cap, acquisition is immediate;
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

import type { EndpointSlotPurpose, EndpointSlotState } from '$lib/types/api';
import type { LoadedEndpoint } from './config';
import { releaseEndpointResources } from './release';

/**
 * What a slot is being held (or waited on) FOR. Every acquisition names one, so
 * the admin endpoint view can say which model is generating and what the
 * background work occupying a single-GPU box actually is.
 *
 * Defined in `$lib/types/api` and aliased here rather than declared twice: two
 * hand-synced copies of the same union is exactly the drift `MODEL_KINDS`
 * exists to avoid, and the compiler only catches one direction of it. Importing
 * a client-safe TYPE into server code is the allowed direction — the rule is
 * that client code may not import from `$lib/server`, not the reverse.
 */
export type SlotPurpose = EndpointSlotPurpose;

/** What a caller declares it is acquiring the slot for. */
export interface SlotWork {
	purpose: SlotPurpose;
	/** Conversation-facing model id, when the caller has one. */
	modelId?: string | null;
}

/**
 * One slot's worth of occupancy — either held or queued.
 *
 * Carries the ENDPOINT id, not just the group's: a group's whole point is that
 * its members are different endpoints sharing one gate, so a group-level count
 * can't say which member is busy. Deliberately carries no conversation or user
 * id — the gate, like the in-flight registry, holds no user identity, and the
 * diagnostic question ("what is this box doing") is answered without one.
 */
interface WorkRecord {
	/**
	 * Process-unique identity for this one slot's worth of work.
	 *
	 * A monotonic counter rather than anything derived from the record's own
	 * fields, because those are NOT unique: `pump` grants waiters in a
	 * synchronous loop, so every record it mints in one pass shares a
	 * `Date.now()`, and a same-model fan-out gives them the same endpoint,
	 * purpose and model id too. The admin view keys its `{#each}` on this, and
	 * Svelte throws on a duplicate key in production — so a tuple that is merely
	 * usually-distinct would take the page down exactly when the queue is busy.
	 */
	id: number;
	endpointId: string;
	purpose: SlotPurpose;
	modelId: string | null;
	/** Unix ms this record was created — enqueued, or granted. */
	since: number;
	/** `queued` while still in line, `releasing` while a handover eviction runs
	 *  ahead of it (see `takeSlot`), `active` once it is genuinely generating. */
	state: EndpointSlotState;
}

/** Source of `WorkRecord.id`. Module-level like the gates themselves; a single
 *  Node process cannot exhaust a float counter at generation rates. */
let nextRecordId = 0;

function workRecord(endpointId: string, work: SlotWork, state: WorkRecord['state']) {
	return {
		id: ++nextRecordId,
		endpointId,
		purpose: work.purpose,
		modelId: work.modelId ?? null,
		since: Date.now(),
		state,
	} satisfies WorkRecord;
}

interface Waiter {
	/** Grant the slot — resolves the caller's pending promise. */
	grant: () => void;
	reject: (err: Error) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
	/** This waiter's declared work, so a queued entry is nameable while it
	 *  waits — the fan-out case the endpoint view exists to explain is a line
	 *  of queued branches, none of which has reached `takeSlot` yet. */
	record: WorkRecord;
	/** Re-report this waiter's current position as the line drains, so the
	 *  client's "N ahead" counts down (not just at enqueue). Same channel as the
	 *  initial onQueued. */
	notifyAhead?: (ahead: number) => void;
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
	/**
	 * True while a handover eviction is in flight. Both grant paths treat it as
	 * zero capacity, which is what actually makes `takeSlot`'s idleness check
	 * mean something: the check is a point-in-time read, and the await after it
	 * runs for as long as an unload takes. Without this, a group with a cap
	 * above 1 can grant a generation mid-eviction — onto the very endpoint being
	 * unloaded. Reserving capacity instead of a flag doesn't work, because `max`
	 * may be Infinity.
	 */
	evicting: boolean;
	/**
	 * The work currently HOLDING a slot in this group, one record per slot.
	 *
	 * Kept alongside `active` rather than derived from it: `active` is a count
	 * and the two can legitimately disagree for the length of one await — a
	 * handover increments before it knows whether the eviction will succeed —
	 * so the count stays the authority for admission and this stays the
	 * authority for display. Every path that decrements `active` deletes here
	 * too, including the eviction's unwind.
	 */
	holders: Set<WorkRecord>;
}

const gates = new Map<string, Gate>();

function getGate(resourceGroup: string, max: number): Gate {
	const existing = gates.get(resourceGroup);
	if (existing) {
		// Reflect the latest configured cap (config could have reloaded).
		existing.max = max;
		return existing;
	}
	const gate: Gate = {
		active: 0,
		max,
		waiters: [],
		lastHolder: null,
		evicting: false,
		holders: new Set(),
	};
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
	 *  granted is unaffected — its own release frees the slot. The one exception
	 *  is a handover eviction: `takeSlot` awaits it after taking the slot, so an
	 *  abort landing there rejects too. It unwinds the slot before rethrowing, so
	 *  "rejected means not holding one" holds either way. */
	signal?: AbortSignal;
	/** Fires when the request had to queue (capacity was full): once
	 *  synchronously with the initial count ahead, then again with the updated
	 *  count each time the line drains in front of it — so the `queued` SSE event
	 *  it emits lets the client count "N ahead" down. Not called on the
	 *  immediate-grant fast path. */
	onQueued?: (info: { ahead: number }) => void;
	/**
	 * The slot is ours, but the group's previous holder is being asked to free
	 * the shared resource first — see `takeSlot`. Fires at most once, on a
	 * handover to a member that is CONFIGURED to release — not on confirmation
	 * that something is actually resident. Deliberately eager: finding out costs
	 * a round-trip to the backend, and this exists to explain a wait, so it has
	 * to arrive at the start of one. The cost is that a handover onto a backend
	 * that already unloaded by itself flashes the status for a no-op.
	 *
	 * Distinct from `onQueued` because it is not queueing: nobody is ahead of
	 * us and there is no position to count down. Without it an eviction plus a
	 * cold model reload reads as "Generating…" with nothing happening, which on
	 * a large model is tens of seconds of apparent hang.
	 */
	onReleasing?: () => void;
	/**
	 * What this acquisition is for, surfaced by `getResourceGroupSnapshot` to the
	 * admin endpoint view.
	 *
	 * REQUIRED. Six of the nine paths that take a slot never touch the
	 * conversation in-flight registry — compaction (both paths), dreaming, memory
	 * summaries, prompt enhancement and title generation — so an undeclared
	 * acquisition shows up on a `max_concurrent = 1` box as an occupied endpoint
	 * with nothing accounted against it, which is the exact confusion the admin
	 * view exists to remove.
	 *
	 * That failure is silent: no crash, no failing test, just a diagnostic
	 * surface quietly under-reporting, discovered only by an operator wondering
	 * why their GPU is busy. A rule in `CLAUDE.md` cannot catch it and a default
	 * would paper over it, so the type does — the same move the relays made when
	 * they replaced an optional `onStarted` hook with a required `inFlight`.
	 */
	work: SlotWork;
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
async function takeSlot(
	gate: Gate,
	endpoint: LoadedEndpoint,
	work: SlotWork,
	signal?: AbortSignal,
	onReleasing?: () => void,
) {
	const previous = gate.lastHolder;
	const handover = gate.active === 1 && previous && previous.id !== endpoint.id && previous.release;

	if (!handover) {
		// Claim the group only when nobody else is still holding the resource.
		// The skipped-eviction case (`active > 1`) is the trap: taking the name
		// there discards the only record of who has a model resident, and every
		// later handover then sees `previous.id === endpoint.id` and skips too —
		// so one overlap between a chat turn and an image request permanently
		// disables the eviction this feature exists to perform.
		if (!previous?.release || previous.id === endpoint.id) gate.lastHolder = endpoint;
		return makeSlot(gate, workRecord(endpoint.id, work, 'active'));
	}

	gate.lastHolder = endpoint;
	gate.evicting = true;
	// Registered BEFORE the eviction await, in the `releasing` state: the slot is
	// already ours and already counted in `active`, so leaving it out would make
	// the group read as occupied by nobody for the whole unload — which on a
	// large model is the longest, most alarming stretch the view has to explain.
	const record = workRecord(endpoint.id, work, 'releasing');
	gate.holders.add(record);
	{
		try {
			// Inside the try: the increment has already happened, so a callback that
			// throws would leak exactly the slot this catch exists to protect. No
			// current caller can (they all write through the SSE writer, which
			// swallows), but the next one shouldn't have to know that.
			onReleasing?.();
			if (!(await releaseEndpointResources(previous, signal))) {
				// It didn't let go. Leave the group pointed at the endpoint that still
				// has the model resident, so the NEXT handover tries again — otherwise
				// the failure is recorded as a completed handover and the retry, which
				// is exactly the request that needs the eviction most, skips it and
				// OOMs again. Non-fatal either way: we still hand over the slot,
				// because the generation would have been attempted regardless.
				gate.lastHolder = previous;
			}
		} catch (e) {
			// The caller's increment happened before this await, and the only thing
			// that ever decrements is the slot's own `release()` — which we are
			// about to not return. So unwind it here or it is leaked for the life
			// of the process: on a cap-1 group (the single-GPU case this exists
			// for) that wedges every later request behind a slot nobody holds.
			//
			// Reachable in normal use: `releaseEndpointResources` rethrows aborts,
			// and the eviction wait is exactly when a user is most likely to hit
			// Stop — it's the phase `onReleasing` exists to make visible.
			gate.active--;
			// Same reasoning, same slot: the record was added before the await, and
			// `makeSlot` — the only other thing that removes one — is about not to
			// be reached. Drop it here or the group displays a phantom holder for
			// the life of the process.
			gate.holders.delete(record);
			// Hand the group back to whoever still actually holds the resource. We
			// never evicted `previous`, so recording ourselves as the holder would
			// suppress the next legitimate eviction and mis-target one at an
			// endpoint that never generated.
			gate.lastHolder = previous;
			throw e;
		} finally {
			// Reopen before pumping, or the waiters this eviction held back stay
			// held back — `pump` reads the same flag.
			gate.evicting = false;
			pump(gate);
		}
	}
	// Survived the eviction — this slot is now doing what it acquired for.
	record.state = 'active';
	return makeSlot(gate, record);
}

/** Wrap an already-counted slot, filing its work record for the diagnostics
 *  snapshot. `add` is idempotent for the handover path, which registered the
 *  same record before its eviction await. */
function makeSlot(gate: Gate, record: WorkRecord): EndpointSlot {
	gate.holders.add(record);
	let released = false;
	return {
		release() {
			if (released) return;
			released = true;
			gate.active--;
			gate.holders.delete(record);
			pump(gate);
		},
	};
}

function pump(gate: Gate): void {
	let granted = 0;
	while (gate.active < gate.max && !gate.evicting && gate.waiters.length > 0) {
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
		try {
			gate.waiters[i].notifyAhead?.(i);
		} catch {
			// Caller-supplied, and `pump` runs from the eviction's finally — where a
			// throw would escape on the SUCCESS path, with the slot counted and no
			// slot object returned. That's the permanent wedge the eviction's own
			// catch exists to prevent, arriving through a different door. Nobody can
			// today (they all write through the SSE writer, which swallows), but a
			// position update is not worth the group for the life of the process.
		}
	}
}

function abortError(): Error {
	return new DOMException('Endpoint slot acquisition aborted', 'AbortError');
}

/**
 * Acquire a slot on the endpoint's resource group, capped at that group's
 * concurrency. Resolves immediately when under capacity, otherwise queues FIFO
 * and resolves once a slot frees. The cap is `endpoint.resourceGroupMaxConcurrent`
 * — resolved at config load, and NOT `endpoint.maxConcurrent`, which is this
 * endpoint's own limit and diverges from it as soon as a group has members.
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
	opts: AcquireOptions,
): Promise<EndpointSlot> {
	const { signal, onQueued, onReleasing, work } = opts;
	// Keyed by RESOURCE GROUP, not endpoint id — which for an endpoint that
	// didn't opt into a group are the same string, so this is the previous
	// behaviour exactly. Taking the endpoint rather than `(id, max)` is
	// deliberate: passing the id by hand is how a caller would silently opt out
	// of its own group, and the two values have to come from the same place to
	// stay consistent.
	const gate = getGate(endpoint.resourceGroup, endpoint.resourceGroupMaxConcurrent);

	if (signal?.aborted) return Promise.reject(abortError());

	// Fast path: capacity available (always true for an effectively-unlimited max)
	// and no eviction in flight.
	if (gate.active < gate.max && !gate.evicting) {
		// Increment BEFORE any await in `takeSlot`: the slot is ours from this
		// moment. At a cap of 1 that alone makes a concurrent acquire queue; above
		// 1 it doesn't, which is what `gate.evicting` is for.
		gate.active++;
		return takeSlot(gate, endpoint, work, signal, onReleasing);
	}

	// Slow path: enqueue. Report how many are already waiting before pushing.
	const ahead = gate.waiters.length;
	onQueued?.({ ahead });

	return new Promise<EndpointSlot>((resolve, reject) => {
		const waiter: Waiter = {
			// `resolve` adopts the promise, so a waiter granted during a handover
			// stays pending until the previous holder has actually let go.
			grant: () => resolve(takeSlot(gate, endpoint, work, signal, onReleasing)),
			reject,
			// Stamped at ENQUEUE, so `since` on a queued entry is how long it has
			// been in line — not how long it has been generating, which is zero.
			// `takeSlot` mints a fresh record on grant, restarting the clock at the
			// moment the work actually starts.
			record: workRecord(endpoint.id, work, 'queued'),
			// Re-emit position as the line drains so the client's "N ahead" counts
			// down. Routes through the same onQueued → `queued` SSE channel.
			notifyAhead: onQueued ? (ahead) => onQueued({ ahead }) : undefined,
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

/** Live counts for a resource group — the test seam for the queue semantics.
 *  The `queued` event's `ahead` value is computed inline in
 *  acquireEndpointSlot, not from this. Returns zeros for a group never seen;
 *  `getResourceGroupSnapshot` is the richer read the admin view uses, and
 *  distinguishes "never seen" from "seen and idle". */
export function getResourceQueueDepth(resourceGroup: string): { active: number; waiting: number } {
	const gate = gates.get(resourceGroup);
	if (!gate) return { active: 0, waiting: 0 };
	return { active: gate.active, waiting: gate.waiters.length };
}

export interface SlotSnapshot {
	/** Stable per-slot identity — see `WorkRecord.id`. Distinct for a waiter and
	 *  for the record minted when that waiter is granted, which is correct: they
	 *  are reported in different lists and are different phases of the work. */
	id: number;
	endpointId: string;
	purpose: SlotPurpose;
	modelId: string | null;
	/** Unix ms — when it entered the line (queued) or started (active). */
	since: number;
	state: EndpointSlotState;
}

export interface ResourceGroupSnapshot {
	resourceGroup: string;
	active: number;
	waiting: number;
	/** The group's gate capacity, or null when effectively unlimited. */
	max: number | null;
	evicting: boolean;
	/** Which member was granted the group's slot most recently — on a shared GPU,
	 *  the endpoint whose model is presumed still resident. */
	lastHolderId: string | null;
	holders: SlotSnapshot[];
	queued: SlotSnapshot[];
}

function cloneRecord(r: WorkRecord): SlotSnapshot {
	return {
		id: r.id,
		endpointId: r.endpointId,
		purpose: r.purpose,
		modelId: r.modelId,
		since: r.since,
		state: r.state,
	};
}

/**
 * A resource group's live occupancy, for the admin endpoint view. Returns null
 * for a group no request has ever touched — a configured-but-idle endpoint has
 * no gate yet, and synthesizing a zeroed one here would need the caller's
 * configured cap anyway, so the caller renders that case from config.
 *
 * A point-in-time copy, not a live view: the arrays are fresh and the records
 * are cloned, so a consumer can't reach into gate state and `max: Infinity`
 * (which `JSON.stringify` turns into `null`) is normalized at the boundary
 * where it's still obvious what it means.
 */
export function getResourceGroupSnapshot(resourceGroup: string): ResourceGroupSnapshot | null {
	const gate = gates.get(resourceGroup);
	if (!gate) return null;
	return {
		resourceGroup,
		active: gate.active,
		waiting: gate.waiters.length,
		/** null = effectively unlimited. */
		max: Number.isFinite(gate.max) ? gate.max : null,
		evicting: gate.evicting,
		lastHolderId: gate.lastHolder?.id ?? null,
		holders: [...gate.holders].map(cloneRecord),
		// In queue order, so the view's list reads the way the line will drain.
		queued: gate.waiters.map((w) => cloneRecord(w.record)),
	};
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
		gate.holders.clear();
	}
	gates.clear();
}
