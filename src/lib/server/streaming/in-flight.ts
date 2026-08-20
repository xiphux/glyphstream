/**
 * Per-conversation in-flight registry. Lets the cancel endpoint reach into
 * active generations and abort the upstream call (chat / image fetch) or
 * issue a bridge-side cancel (video).
 *
 * A conversation can have MORE THAN ONE generation in flight at once: a
 * multi-model fan-out fires N branch requests against the same conversation,
 * each producing a sibling assistant message. So entries are keyed by
 * conversation id AND a per-branch key. A plain single send uses the
 * `DEFAULT_BRANCH` key, preserving the old one-at-a-time semantics (a second
 * default send aborts the prior). Fan-out branches each pass a distinct key
 * so they coexist instead of cancelling one another.
 *
 * Module-level Map is fine for single-process. With multiple replicas this
 * would need a shared store; that's a v2 concern, not a v1 one.
 *
 * Why a registry instead of just listening for client disconnects: the
 * design intentionally lets the recorder finish on flaky connections (close
 * laptop, come back later, message is there). We only want to abort upstream
 * when the user *explicitly* stops — which is a separate signal from the
 * underlying TCP close.
 */

import type { LoadedEndpoint } from '../endpoints/config';
import type { ModelKind } from '$lib/types/api';
import { MAX_FANOUT_BRANCHES_PER_CONVERSATION } from '$lib/fanout';

/** Key for a plain single-generation turn — at most one at a time per
 *  conversation, matching the pre-fan-out behavior. */
export const DEFAULT_BRANCH = 'default';

/**
 * Key for an avatar generation — a side errand, not part of the conversation's
 * turn. Distinct from DEFAULT_BRANCH so an ordinary send doesn't abort a
 * drawing (and vice versa), and stable rather than per-call so a second draw
 * supersedes the first.
 *
 * Named here rather than written as a literal at the route because two readers
 * have to agree it isn't a turn — see `conversationTurnEntries`.
 */
export const AVATAR_BRANCH = 'avatar';

export interface InFlightEntry {
	/**
	 * Whether this entry is part of the conversation's TURN — a plain send or a
	 * fan-out branch — as opposed to a side errand like an avatar draw.
	 *
	 * An explicit field rather than a test on `branchKey`, because there is no
	 * positive test available there: fan-out keys are `generateId()`, so key
	 * matching can only ever say "not avatar", and the next side errand would be
	 * silently readmitted as a turn. Defaults to true so every existing
	 * registrant keeps its meaning without opting in.
	 */
	isTurn: boolean;
	controller: AbortController;
	endpoint: LoadedEndpoint;
	/** Unix ms when the generation was registered. Surfaced to the client
	 *  (via the conversation load function) so a "Generating…" indicator
	 *  recovered after an iOS suspension can show a truthful elapsed timer
	 *  instead of restarting from zero. */
	startedAt: number;
	/** For video kind: bridge-side job id, set as soon as videoCreate returns. */
	videoJobId?: string;
	/** The key this entry is filed under within its conversation. */
	branchKey: string;
	/** This generation's modality — lets fan-out recovery render the right
	 *  (media vs chat) compare grid even when no branch has persisted yet. */
	modelKind: ModelKind | null;
	/** This generation's model id — lets a recovered fan-out label each
	 *  still-generating placeholder with its model (not a bare "Generating…"),
	 *  matching the live grid. */
	modelId: string | null;
	/** Unix ms when this branch actually began generating (acquired its
	 *  concurrency slot — the relay sets this when it emits `start`), or null
	 *  while still queued behind the gate. Lets a recovered fan-out distinguish
	 *  a QUEUED branch from a generating one + restore its elapsed timer. */
	generationStartedAt: number | null;
	/** Split-attachments input image this branch is editing / animating, or null
	 *  for text-to-media. Lets a recovered fan-out keep the input thumbnail on
	 *  branches that are still generating — until one persists there's no output
	 *  media row to read the provenance off. */
	sourceMediaId: string | null;
}

const inFlight = new Map<string, Map<string, InFlightEntry>>();

/**
 * Register a new in-flight generation under `branchKey`. If an entry already
 * exists for this conversation+branch (rare for the default branch — the UI
 * prevents a second concurrent default send, but defend anyway), abort it
 * first so the same slot never has two upstream calls racing. Sibling
 * fan-out branches use different keys and are left untouched.
 */
export function registerInFlight(
	conversationId: string,
	endpoint: LoadedEndpoint,
	branchKey: string = DEFAULT_BRANCH,
	modelKind: ModelKind | null = null,
	modelId: string | null = null,
	sourceMediaId: string | null = null,
	isTurn = true,
): InFlightEntry {
	let byBranch = inFlight.get(conversationId);
	if (!byBranch) {
		byBranch = new Map();
		inFlight.set(conversationId, byBranch);
	}
	const prior = byBranch.get(branchKey);
	if (prior) prior.controller.abort();
	const entry: InFlightEntry = {
		controller: new AbortController(),
		endpoint,
		startedAt: Date.now(),
		branchKey,
		isTurn,
		modelKind,
		modelId,
		sourceMediaId,
		// Null until the relay acquires its slot + starts generating (it sets
		// this when it emits `start`); a recovered fan-out uses it to tell a
		// QUEUED branch from a generating one + restore the elapsed timer.
		generationStartedAt: null,
	};
	byBranch.set(branchKey, entry);
	return entry;
}

export function clearInFlight(conversationId: string, entry: InFlightEntry): void {
	const byBranch = inFlight.get(conversationId);
	if (!byBranch) return;
	// Only clear if the slot still holds *our* entry — protects against the
	// case where a new generation has already overwritten this slot.
	if (byBranch.get(entry.branchKey) === entry) byBranch.delete(entry.branchKey);
	if (byBranch.size === 0) inFlight.delete(conversationId);
}

/**
 * The entries that belong to the conversation's own TURN — a plain send or a
 * fan-out's branches — excluding side errands like an avatar draw.
 *
 * Three consumers reason about "is the turn finished": the fan-out recovery
 * state (how many columns are still generating), the aggregate fan-out
 * notification (am I the last branch), and `getInFlightSince` (is this client
 * looking at a generation it should be rendering). All were written when every
 * entry was necessarily part of one dispatch, and each breaks differently on a
 * foreign entry — the grid grows a phantom column that flips it to a media
 * layout and blocks picking, the "N ready" push is dropped entirely because no
 * branch ever finds the registry empty, and the recovery poll never terminates.
 *
 * Deliberately NOT the callers that ask a different question:
 * `conversationFanoutAtCapacity` is a resource cap and a draw really does hold
 * a slot, and `filterInFlight` drives the sidebar's "still cooking" dot, which
 * a background draw genuinely is — it's the only signal for work started on
 * another device.
 */
export function conversationTurnEntries(conversationId: string): InFlightEntry[] {
	return getInFlightEntries(conversationId).filter((e) => e.isTurn);
}

/** All in-flight entries for a conversation (one for a plain send, N during a
 *  fan-out, plus any side errand). Empty array when nothing is running. */
export function getInFlightEntries(conversationId: string): InFlightEntry[] {
	const byBranch = inFlight.get(conversationId);
	return byBranch ? [...byBranch.values()] : [];
}

/** True when the conversation already has the maximum number of concurrent
 *  generations in flight — the dispatch handler 429s a further fan-out branch
 *  past this, bounding the standing queue of held-open connections + registry
 *  entries that an unbounded fan-out would otherwise pile up. */
export function conversationFanoutAtCapacity(conversationId: string): boolean {
	return getInFlightEntries(conversationId).length >= MAX_FANOUT_BRANCHES_PER_CONVERSATION;
}

/**
 * Narrow `conversationIds` down to the ones with at least one generation in
 * flight — the sidebar's "still cooking" dot.
 *
 * Takes the ids rather than enumerating the registry, because the registry is
 * keyed by conversation id alone and carries no user identity: a raw
 * `inFlight.keys()` would be an unscoped read of user-owned state. Callers
 * pass a list they've already scoped (the user's own conversation list), so
 * ownership is established before this is reached.
 */
export function filterInFlight(conversationIds: readonly string[]): string[] {
	return conversationIds.filter((id) => inFlight.has(id));
}

/** Earliest `startedAt` across the conversation's in-flight generations, or
 *  null when none — the truthful "generating since" for the recovery
 *  indicator regardless of how many branches are running. */
export function getInFlightSince(conversationId: string): number | null {
	// Turn-scoped: this feeds the client's recovered-turn bubble and the poll
	// that waits for it to clear. An avatar draw isn't a turn this client should
	// be rendering, and counting it wedges that poll — it terminates only on
	// null — leaving a phantom "Generating…" and a disabled composer for the
	// whole draw.
	const entries = conversationTurnEntries(conversationId);
	if (entries.length === 0) return null;
	let earliest = entries[0].startedAt;
	for (const e of entries) if (e.startedAt < earliest) earliest = e.startedAt;
	return earliest;
}

/** Test/dev only. */
export function resetInFlight(): void {
	for (const byBranch of inFlight.values()) {
		for (const entry of byBranch.values()) entry.controller.abort();
	}
	inFlight.clear();
}
