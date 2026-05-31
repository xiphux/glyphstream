/**
 * The internal model-id grammar: `{endpoint_id}::{upstream_model_id}`.
 *
 * `::` is the separator (not `/`) because some upstream model ids contain
 * `/` — HuggingFace-style repo ids. parseModelId and formatModelId are
 * the only two places that encode this grammar; everything that needs to
 * split or build an internal model id routes through here so the
 * separator and its edge cases stay defined exactly once.
 *
 * Lives in its own module (rather than registry.ts) so config.ts can
 * validate `task_model` against the same parser without forming an
 * import cycle with the registry.
 */

/**
 * Parse an internal model id into its two parts. Returns null for
 * malformed input — no `::` separator, an empty endpoint id, or an empty
 * upstream id.
 */
export function parseModelId(modelId: string): { endpointId: string; upstreamId: string } | null {
	const idx = modelId.indexOf('::');
	if (idx <= 0 || idx === modelId.length - 2) return null;
	return {
		endpointId: modelId.slice(0, idx),
		upstreamId: modelId.slice(idx + 2),
	};
}

/** Build an internal model id from its endpoint + upstream parts. */
export function formatModelId(endpointId: string, upstreamId: string): string {
	return `${endpointId}::${upstreamId}`;
}
