/**
 * Shared resolution for the optional retrieval legs — `[embeddings]` (semantic
 * ranking) and `[rerank]` (cross-encoder reordering).
 *
 * `embeddings-config.ts` and `rerank-config.ts` were structural twins, and the
 * second said so ("mirroring `embeddings-config.ts`").
 *
 * ## Why this is NOT `createModelResolver`
 *
 * The failure contract is deliberately weaker here. A model resolver lets a
 * malformed block throw, so the operator sees their syntax error. These two
 * swallow it: both legs are optional upgrades whose absence degrades retrieval
 * (embeddings → BM25-only, rerank → keep the fused order) rather than breaking
 * it, and they are read from places that must not throw — including tool
 * *advertisement*, where `recall_memory`'s `isAvailable()` runs. A ConfigError
 * escaping there would take out the tool list, not just the ranking.
 *
 * So: a missing, unreadable, or malformed block disables the leg with a warning.
 * Memoization makes that warning fire once rather than per call.
 *
 * The endpoint lookup is intentionally left OUT of the memo — it's re-resolved on
 * each call, matching what both modules already did.
 */

import { getEndpoint } from '../endpoints/registry';

export interface OptionalEndpointConfigOptions<Cfg, Resolved> {
	/** Log prefix, without brackets — both legs log under `retrieval`. */
	name: string;
	/** The config block, for the warning text — e.g. `[embeddings]`. */
	block: string;
	/** What stops working, for the warning text — e.g. `embeddings disabled`. */
	disabledNote: string;
	/** Read the block. Null when unset; may throw, which is caught and warned. */
	load: () => Cfg | null;
	/** Pull the endpoint id out of the loaded block. */
	endpointIdOf: (cfg: Cfg) => string;
	/** Map the block + resolved endpoint onto the usable config. */
	build: (cfg: Cfg, endpoint: NonNullable<ReturnType<typeof getEndpoint>>) => Resolved;
}

export interface OptionalEndpointConfig<Resolved> {
	/**
	 * The usable config, or undefined when the leg isn't configured / its endpoint
	 * no longer resolves. Undefined makes the caller degrade, never error.
	 */
	resolve(): Resolved | undefined;
	/** Test hook: clear the memoized load so the next call re-reads. */
	reset(): void;
}

export function createOptionalEndpointConfig<Cfg, Resolved>(
	opts: OptionalEndpointConfigOptions<Cfg, Resolved>,
): OptionalEndpointConfig<Resolved> {
	const { name, block, disabledNote, load, endpointIdOf, build } = opts;

	let cache: { value: Cfg | null } | undefined;

	function loadOnce(): Cfg | null {
		if (!cache) {
			let value: Cfg | null = null;
			try {
				value = load();
			} catch (e) {
				console.warn(`[${name}] could not load ${block} config; ${disabledNote}:`, e);
			}
			cache = { value };
		}
		return cache.value;
	}

	return {
		resolve(): Resolved | undefined {
			const cfg = loadOnce();
			if (!cfg) return undefined;
			const endpoint = getEndpoint(endpointIdOf(cfg));
			if (!endpoint) return undefined;
			return build(cfg, endpoint);
		},
		reset(): void {
			cache = undefined;
		},
	};
}
