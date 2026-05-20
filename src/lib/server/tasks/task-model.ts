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

import { ConfigError, loadTaskModel, type LoadedEndpoint } from '../endpoints/config';
import { getEndpoint, parseModelId } from '../endpoints/registry';

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

	let rawId: string | null;
	try {
		rawId = loadTaskModel();
	} catch (e) {
		// Malformed task_model (wrong shape / wrong type) IS surfaceable —
		// it's a config syntax error the operator should see. Re-throw so
		// the standard ConfigError pipeline reports it at boot.
		if (e instanceof ConfigError) throw e;
		throw e;
	}

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
			`[task-model] task_model "${rawId}" references endpoint "${parsed.endpointId}" which is not configured; ignoring`
		);
		cached = { resolved: null };
		return null;
	}

	const resolved: ResolvedTaskModel = { endpoint, upstreamId: parsed.upstreamId };
	cached = { resolved };
	return resolved;
}

/** Test/dev only: discard the cached resolution so the next access reloads. */
export function resetTaskModel(): void {
	cached = null;
}
