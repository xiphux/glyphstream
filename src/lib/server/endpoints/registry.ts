import { loadEndpoints, type LoadedEndpoint } from './config';

let cached: Map<string, LoadedEndpoint> | null = null;

/**
 * Build (and memoize) the endpoint registry on first access.
 *
 * Construct the new map locally first and only assign to `cached` after
 * loadEndpoints() returns successfully. Otherwise a throw mid-build
 * would leave `cached` set to an empty Map (truthy), and subsequent
 * callers would see an empty registry without retrying — silent bug
 * masquerading as "endpoints aren't configured" once the actual cause
 * was a transient file-read or env-resolution failure.
 */
export function getRegistry(): Map<string, LoadedEndpoint> {
	if (cached) return cached;
	const next = new Map<string, LoadedEndpoint>();
	for (const ep of loadEndpoints()) {
		next.set(ep.id, ep);
	}
	cached = next;
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
