/**
 * Ceiling on a single `GET /api/models?ids=` lookup.
 *
 * Shared rather than duplicated because the two sides mean different things by
 * it and both are load-bearing: the server truncates a longer list, and the
 * client records every id it SENT as definitively answered. A client batch
 * larger than the server's cap would therefore remember the dropped tail as
 * "no such model" without ever having asked — the exact silent false negative
 * the catalogue is built to avoid. Two constants that merely happened to agree
 * left that one careless edit away.
 *
 * Client-safe (no `$lib/server` imports), so the route and the store can both
 * reach it.
 */
export const MAX_MODEL_IDS_PER_REQUEST = 200;

/**
 * The endpoint half of an `endpointId::upstreamId` id, or null if it has none.
 *
 * A client-safe twin of `parseModelId` (`$lib/server/endpoints/model-id`), which
 * is the canonical encoder of this grammar but lives under `$lib/server` and so
 * cannot be reached from browser code. Kept to the same edge cases on purpose —
 * no separator, an empty endpoint half, or a trailing separator all yield null —
 * because the alternative the client reached for was `id.slice(0, id.indexOf(
 * '::'))`, which returns the id minus its last character for a bare id.
 */
export function endpointIdOf(modelId: string): string | null {
	const idx = modelId.indexOf('::');
	if (idx <= 0 || idx === modelId.length - 2) return null;
	return modelId.slice(0, idx);
}
