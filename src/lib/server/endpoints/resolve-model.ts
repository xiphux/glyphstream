/**
 * Shared resolution for the "a config block names a model" slots — `task_model`,
 * `[image_enhancement]`, `[memory_model]`.
 *
 * All three did the identical five-step dance: memoize, load the block, bail on
 * unset, `parseModelId`, look the endpoint up in the registry — warning once and
 * degrading to null at each failure — then map the block's extra knobs onto the
 * resolved object. Their comments admitted the copying ("Mirrors `task-model.ts`",
 * "Mirrors `image-enhancer-model.ts`").
 *
 * ## The failure contract, in one place
 *
 * Resolution failure is deliberately non-fatal and tri-state:
 *
 *   - **Unset** → null, silently. The feature is simply off.
 *   - **Set but unresolvable** (typo, endpoint removed from config) → null, with a
 *     one-time warning. Memoization is what makes it one-time. Visible to the
 *     operator without taking the process down.
 *   - **Malformed** (the loader throws `ConfigError`) → propagates. A syntax error
 *     is a real mistake the operator needs to see, not a feature to quietly skip.
 *
 * Boot must not crash on misconfiguration, and per-call sites must not surface
 * user-visible errors when the model is gone — callers just take their
 * "not configured" path.
 *
 * The resolved endpoint is memoized along with everything else, matching what all
 * three resolvers already did: config doesn't reload at runtime, so neither does
 * the registry lookup behind it.
 */

import { getEndpoint } from './registry';
import { parseModelId } from './model-id';
import type { LoadedEndpoint } from './config';

/** The part every resolved model has; `build` decorates it with block-specific knobs. */
export interface ResolvedModelBase {
	endpoint: LoadedEndpoint;
	upstreamId: string;
}

export interface ModelResolverOptions<Cfg, Resolved extends ResolvedModelBase> {
	/** Log prefix, without brackets — e.g. `task-model` logs as `[task-model]`. */
	name: string;
	/**
	 * Read the config block. Return null when unset. May throw `ConfigError` for a
	 * malformed block — that propagates by design.
	 */
	load: () => Cfg | null;
	/** Pull the `endpoint/model` string out of the loaded block. */
	modelIdOf: (cfg: Cfg) => string;
	/** Decorate the resolved base with the block's extra knobs. */
	build: (base: ResolvedModelBase, cfg: Cfg) => Resolved;
}

export interface ModelResolver<Resolved> {
	/** Resolve, memoized on first access. Null when unset or unresolvable. */
	get(): Resolved | null;
	/** Test/dev only: discard the cached resolution so the next access reloads. */
	reset(): void;
}

export function createModelResolver<Cfg, Resolved extends ResolvedModelBase>(
	opts: ModelResolverOptions<Cfg, Resolved>,
): ModelResolver<Resolved> {
	const { name, load, modelIdOf, build } = opts;

	// The extra object wrapper distinguishes "not yet resolved" from "resolved to
	// null" — without it an unset model would re-run the whole load on every call.
	let cached: { resolved: Resolved | null } | null = null;

	return {
		get(): Resolved | null {
			if (cached) return cached.resolved;

			const cfg = load();
			if (!cfg) {
				cached = { resolved: null };
				return null;
			}

			const rawId = modelIdOf(cfg);
			const parsed = parseModelId(rawId);
			if (!parsed) {
				// The loader already validated the shape, so this is belt-and-suspenders.
				console.warn(`[${name}] model "${rawId}" failed to parse; ignoring`);
				cached = { resolved: null };
				return null;
			}

			const endpoint = getEndpoint(parsed.endpointId);
			if (!endpoint) {
				console.warn(
					`[${name}] model "${rawId}" references endpoint "${parsed.endpointId}" which is not configured; ignoring`,
				);
				cached = { resolved: null };
				return null;
			}

			const resolved = build({ endpoint, upstreamId: parsed.upstreamId }, cfg);
			cached = { resolved };
			return resolved;
		},

		reset(): void {
			cached = null;
		},
	};
}
