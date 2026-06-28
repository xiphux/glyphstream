/**
 * Resolution layer for the `[image_enhancement]` config block — the model used
 * to rewrite image prompts into a target image model's preferred style before
 * generation. Mirrors `task-model.ts`: memoized resolution, non-fatal failure.
 *
 * Resolution failure modes are intentionally non-fatal: if `[image_enhancement]`
 * is unset, or set but unresolvable (typo / removed endpoint), the caller gets
 * `null` and skips enhancement (the prompt passes through verbatim). Boot must
 * not crash on misconfiguration; per-call sites must not surface user-visible
 * errors when the enhancer model is gone.
 */

import { loadImageEnhancementConfig, type LoadedEndpoint } from '../endpoints/config';
import { getEndpoint } from '../endpoints/registry';
import { parseModelId } from '../endpoints/model-id';

export interface ResolvedImageEnhancerModel {
	endpoint: LoadedEndpoint;
	upstreamId: string;
	maxTokens: number;
	temperature: number;
	styleInstructionOverrides: Record<string, string>;
}

let cached: { resolved: ResolvedImageEnhancerModel | null } | null = null;

/**
 * Resolve the configured enhancer model to an endpoint + upstream id + knobs.
 * Memoized on first access; returns null when `[image_enhancement]` is unset OR
 * when the referenced endpoint isn't in the registry. The latter logs a
 * one-time warning so misconfigurations are visible without crashing.
 */
export function getImageEnhancerModel(): ResolvedImageEnhancerModel | null {
	if (cached) return cached.resolved;

	// A malformed [image_enhancement] block (the only thing
	// loadImageEnhancementConfig throws is ConfigError) is intentionally left to
	// propagate, so the operator sees the syntax error at boot/use. Only an
	// *unset* — or a well-formed but unresolvable — value disables enhancement
	// (the null/registry checks below).
	const cfg = loadImageEnhancementConfig();

	if (!cfg) {
		cached = { resolved: null };
		return null;
	}

	const parsed = parseModelId(cfg.model);
	if (!parsed) {
		// loadImageEnhancementConfig already validated the shape; belt-and-suspenders.
		console.warn(`[image-enhancer] model "${cfg.model}" failed to parse; ignoring`);
		cached = { resolved: null };
		return null;
	}

	const endpoint = getEndpoint(parsed.endpointId);
	if (!endpoint) {
		console.warn(
			`[image-enhancer] model "${cfg.model}" references endpoint "${parsed.endpointId}" which is not configured; ignoring`,
		);
		cached = { resolved: null };
		return null;
	}

	const resolved: ResolvedImageEnhancerModel = {
		endpoint,
		upstreamId: parsed.upstreamId,
		maxTokens: cfg.maxTokens,
		temperature: cfg.temperature,
		styleInstructionOverrides: cfg.styleInstructionOverrides,
	};
	cached = { resolved };
	return resolved;
}

/** Test/dev only: discard the cached resolution so the next access reloads. */
export function resetImageEnhancerModel(): void {
	cached = null;
}
