/**
 * Pure validation/resolution helpers for the messages dispatch handler, pulled
 * out of the route so the fan-out invariants can be unit-tested directly (the
 * route itself is awkward to drive). Two guards live here:
 *
 *  - `resolveModelOverride` — a per-turn model override. THE linchpin: a fan-out
 *    branch's model is TRANSIENT and must never be persisted as the
 *    conversation's default, or N concurrent branches would clobber it
 *    (whichever finished last wins). Returns `persist: false` for a fan-out so
 *    the caller skips the conversation-model write.
 *  - `isValidReplaceTarget` — a fan-out regenerate's `replacesMessageId`
 *    triggers a real server-side delete of that message + subtree once the
 *    re-roll lands, so a forged id is dangerous. Honor it only when it's an
 *    assistant sibling under this fan-out's shared user message.
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
 * Whether `replacesMessageId` (resolved to `target`) is a legitimate
 * regenerate target: an assistant message parented directly to this fan-out's
 * shared user message. Anything else (a user message, a sibling of a different
 * parent, an unknown id) is rejected so a forged id can't delete arbitrary
 * messages when the re-roll lands.
 */
export function isValidReplaceTarget(
	target: { role: string; parentMessageId?: string | null } | null | undefined,
	parentMessageId: string,
): boolean {
	return !!target && target.role === 'assistant' && target.parentMessageId === parentMessageId;
}
