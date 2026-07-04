/**
 * Resolution layer for the `[memory_model]` config block — the capable model the
 * phase-4 memory-consolidation ("dreaming") worker uses to merge/reword/prune a
 * user's saved memories. Mirrors `image-enhancer-model.ts`: memoized resolution,
 * non-fatal failure, plus the schedule fields the worker gates on.
 *
 * Deliberately a separate tier from `task_model`: merging facts without dropping
 * them needs a capable model, not the small utility model that titles chats.
 *
 * Failure is non-fatal: unset, or set-but-unresolvable (typo / removed endpoint)
 * → `null`, and the dreaming worker simply doesn't mount. Boot must not crash on
 * misconfiguration.
 */

import { loadMemoryModelConfig, type LoadedEndpoint } from '../endpoints/config';
import { getEndpoint } from '../endpoints/registry';
import { parseModelId } from '../endpoints/model-id';

export interface ResolvedMemoryModel {
	endpoint: LoadedEndpoint;
	upstreamId: string;
	maxTokens: number;
	temperature: number;
	/** "HH:MM-HH:MM" quiet-hours window, or '' for always-open. */
	activeHours: string;
	/** IANA zone the window is interpreted in. */
	timezone: string;
}

let cached: { resolved: ResolvedMemoryModel | null } | null = null;

/**
 * Resolve the configured memory model to an endpoint + upstream id + knobs +
 * schedule. Memoized on first access; returns null when `[memory_model]` is unset
 * OR the referenced endpoint isn't in the registry (a one-time warning for the
 * latter). A malformed block (ConfigError) propagates so the operator sees it.
 */
export function getMemoryModel(): ResolvedMemoryModel | null {
	if (cached) return cached.resolved;

	const cfg = loadMemoryModelConfig();
	if (!cfg) {
		cached = { resolved: null };
		return null;
	}

	const parsed = parseModelId(cfg.model);
	if (!parsed) {
		console.warn(`[memory-model] model "${cfg.model}" failed to parse; ignoring`);
		cached = { resolved: null };
		return null;
	}

	const endpoint = getEndpoint(parsed.endpointId);
	if (!endpoint) {
		console.warn(
			`[memory-model] model "${cfg.model}" references endpoint "${parsed.endpointId}" which is not configured; ignoring`,
		);
		cached = { resolved: null };
		return null;
	}

	const resolved: ResolvedMemoryModel = {
		endpoint,
		upstreamId: parsed.upstreamId,
		maxTokens: cfg.maxTokens,
		temperature: cfg.temperature,
		activeHours: cfg.activeHours,
		timezone: cfg.timezone,
	};
	cached = { resolved };
	return resolved;
}

/** Test/dev only: discard the cached resolution so the next access reloads. */
export function resetMemoryModel(): void {
	cached = null;
}
