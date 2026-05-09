import { loadEndpoints, type LoadedEndpoint } from './config';

let cached: Map<string, LoadedEndpoint> | null = null;

/** Build (and memoize) the endpoint registry on first access. */
export function getRegistry(): Map<string, LoadedEndpoint> {
	if (!cached) {
		cached = new Map();
		for (const ep of loadEndpoints()) {
			cached.set(ep.id, ep);
		}
	}
	return cached;
}

export function getEndpoint(id: string): LoadedEndpoint | undefined {
	return getRegistry().get(id);
}

export function listEndpoints(): LoadedEndpoint[] {
	return [...getRegistry().values()];
}

/** Test/dev only: discard the cached registry so the next access reloads. */
export function resetRegistry(): void {
	cached = null;
}

/**
 * Parse an internal model id of shape `{endpoint_id}::{upstream_model_id}`
 * into its two parts. Returns null for malformed input.
 *
 * `::` separator chosen because some upstream model ids contain `/`
 * (HuggingFace style), so `/` is unsafe as our separator.
 */
export function parseModelId(modelId: string): { endpointId: string; upstreamId: string } | null {
	const idx = modelId.indexOf('::');
	if (idx <= 0 || idx === modelId.length - 2) return null;
	return {
		endpointId: modelId.slice(0, idx),
		upstreamId: modelId.slice(idx + 2)
	};
}

export function formatModelId(endpointId: string, upstreamId: string): string {
	return `${endpointId}::${upstreamId}`;
}
