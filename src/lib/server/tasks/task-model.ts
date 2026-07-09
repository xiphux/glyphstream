/**
 * Resolution layer for the global `task_model` config slot — the model
 * used for utility tasks (title generation today; follow-up suggestions,
 * retrieval-query extraction, etc. in future). Lives separately from the
 * title generator so other task types can share the resolution.
 *
 * Resolution failure modes are intentionally non-fatal: if `task_model`
 * is unset, or set but unresolvable (typo, removed endpoint), the
 * caller gets `null` and skips its task — falling back to whatever the
 * task's "no task model configured" path is. Boot must not crash on
 * `task_model` misconfiguration; per-call sites must not surface
 * user-visible errors when the task model is gone.
 */

import { loadTaskModel, loadTaskModelConfig, type LoadedEndpoint } from '../endpoints/config';
import { getEndpoint } from '../endpoints/registry';
import { parseModelId } from '../endpoints/model-id';

export interface ResolvedTaskModel {
	endpoint: LoadedEndpoint;
	upstreamId: string;
}

let cached: { resolved: ResolvedTaskModel | null } | null = null;

/**
 * Resolve the configured task model to an endpoint + upstream id. Memoized
 * on first access; returns null when `task_model` is unset OR when the
 * referenced endpoint isn't in the registry. The latter case logs a
 * one-time warning so misconfigurations are visible without crashing.
 */
export function getTaskModel(): ResolvedTaskModel | null {
	if (cached) return cached.resolved;

	// A malformed task_model (the only thing loadTaskModel throws is
	// ConfigError) is intentionally left to propagate, so the operator sees the
	// syntax error at boot/use. Only an *unset* — or a well-formed but
	// unresolvable — value disables titling (the null/registry checks below).
	const rawId = loadTaskModel();

	if (!rawId) {
		cached = { resolved: null };
		return null;
	}

	const parsed = parseModelId(rawId);
	if (!parsed) {
		// loadTaskModel already validated the shape, so this branch is
		// theoretically unreachable; guard belt-and-suspenders.
		console.warn(`[task-model] task_model "${rawId}" failed to parse; ignoring`);
		cached = { resolved: null };
		return null;
	}

	const endpoint = getEndpoint(parsed.endpointId);
	if (!endpoint) {
		console.warn(
			`[task-model] task_model "${rawId}" references endpoint "${parsed.endpointId}" which is not configured; ignoring`,
		);
		cached = { resolved: null };
		return null;
	}

	const resolved: ResolvedTaskModel = { endpoint, upstreamId: parsed.upstreamId };
	cached = { resolved };
	return resolved;
}

/**
 * Whether the configured task model is trusted with Private chat content
 * (`[task_model] private = true`). Gates whether a Private chat may be auto-titled
 * by it — titling ships the first exchange to the task model, which is a secondary
 * model unrelated to the chat's own, so a private chat only does it when the
 * operator has vouched for the task model. Memoized; false when task_model is
 * unset or configured in the bare-string form.
 */
export function isTaskModelPrivate(): boolean {
	if (privateCache) return privateCache.value;
	const value = loadTaskModelConfig()?.private ?? false;
	privateCache = { value };
	return value;
}
let privateCache: { value: boolean } | null = null;

/** Test/dev only: discard the cached resolution so the next access reloads. */
export function resetTaskModel(): void {
	cached = null;
	privateCache = null;
}
