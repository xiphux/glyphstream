/**
 * Pure validation/resolution helpers for the messages dispatch handler, pulled
 * out of the route so the fan-out invariants can be unit-tested directly (the
 * route itself is awkward to drive):
 *
 *  - `resolveModelOverride` — a per-turn model override. THE linchpin: a fan-out
 *    branch's model is TRANSIENT and must never be persisted as the
 *    conversation's default, or N concurrent branches would clobber it
 *    (whichever finished last wins). Returns `persist: false` for a fan-out so
 *    the caller skips the conversation-model write.
 */

import { isModelKind } from '$lib/types/api';
import type { ModelKind } from '$lib/types/api';

export class ModelOverrideError extends Error {}

export interface ResolvedModelOverride {
	/** The (endpointId, modelId, modelKind) to apply to THIS dispatch, or null
	 *  when the body carried no model change (use the conversation's stored
	 *  model). */
	override: { endpointId: string; modelId: string; modelKind: ModelKind | null } | null;
	/** Whether to persist `override` as the conversation's default. Always false
	 *  for a fan-out branch — that's the transient-override invariant. */
	persist: boolean;
}

/**
 * Resolve a per-turn model override from the request body against the
 * conversation's current model. Throws `ModelOverrideError` (→ the route maps to
 * 400) on a malformed id or unconfigured endpoint. `parseEndpointId` +
 * `endpointExists` are injected so this stays pure + testable without config.
 */
export function resolveModelOverride(input: {
	bodyModelId: unknown;
	bodyModelKind: unknown;
	currentModelId: string;
	currentModelKind: ModelKind | null;
	isFanout: boolean;
	parseEndpointId: (modelId: string) => string | null;
	endpointExists: (endpointId: string) => boolean;
}): ResolvedModelOverride {
	const { bodyModelId } = input;
	// No override: not a string, empty, or already the conversation's model.
	if (typeof bodyModelId !== 'string' || !bodyModelId || bodyModelId === input.currentModelId) {
		return { override: null, persist: false };
	}
	const endpointId = input.parseEndpointId(bodyModelId);
	if (!endpointId) throw new ModelOverrideError(`modelId "${bodyModelId}" is malformed`);
	if (!input.endpointExists(endpointId)) {
		throw new ModelOverrideError(`Endpoint "${endpointId}" is not configured`);
	}
	const modelKind = isModelKind(input.bodyModelKind) ? input.bodyModelKind : input.currentModelKind;
	return {
		override: { endpointId, modelId: bodyModelId, modelKind },
		// Fan-out branch → transient: never write the conversation row.
		persist: !input.isFanout,
	};
}

/**
 * Narrow a request body's `branchIndex` into what gets persisted as the
 * assistant row's `fanout_index` — the branch's display position in its
 * comparison grid.
 *
 * Only meaningful on a fan-out branch, so a non-fan-out send discards it
 * outright rather than stamping a grid position onto a thread message. It is a
 * pure sort key (never arithmetic, never a bound on anything), so the only real
 * requirement is that it be a sane non-negative integer: `typeof x === 'number'`
 * alone admits `1e999`, which JSON.parse hands over as Infinity and SQLite
 * stores as a float that then sorts against every real index.
 *
 * NOT bounded by MAX_FANOUT_BRANCHES_PER_CONVERSATION: indices are assigned past
 * the highest already under the anchor, so successive avatar-draw rounds climb
 * well beyond one grid's worth of branches while each round stays within the cap.
 */
export function resolveBranchIndex(raw: unknown, isFanout: boolean): number | null {
	if (!isFanout) return null;
	return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
}
