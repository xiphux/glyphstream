/**
 * Resolution layer for the `[image_enhancement]` config block — the model used
 * to rewrite image prompts into a target image model's preferred style before
 * generation.
 *
 * Resolution semantics (unset → null, unresolvable → null + one-time warning,
 * malformed → throw) are the shared `createModelResolver` contract. A null here
 * means the prompt passes through to the image model verbatim.
 */

import { loadImageEnhancementConfig, type LoadedEndpoint } from '../endpoints/config';
import { createModelResolver } from '../endpoints/resolve-model';

export interface ResolvedImageEnhancerModel {
	endpoint: LoadedEndpoint;
	upstreamId: string;
	maxTokens: number;
	temperature: number;
	styleInstructionOverrides: Record<string, string>;
}

const resolver = createModelResolver({
	name: 'image-enhancer',
	load: loadImageEnhancementConfig,
	modelIdOf: (cfg) => cfg.model,
	build: (base, cfg): ResolvedImageEnhancerModel => ({
		...base,
		maxTokens: cfg.maxTokens,
		temperature: cfg.temperature,
		styleInstructionOverrides: cfg.styleInstructionOverrides,
	}),
});

/**
 * Resolve the configured enhancer model to an endpoint + upstream id + knobs.
 * Memoized on first access; returns null when `[image_enhancement]` is unset OR
 * when the referenced endpoint isn't in the registry.
 */
export function getImageEnhancerModel(): ResolvedImageEnhancerModel | null {
	return resolver.get();
}

/** Test/dev only: discard the cached resolution so the next access reloads. */
export function resetImageEnhancerModel(): void {
	resolver.reset();
}
