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

/**
 * The picker-shape model id for a media row's `(sourceEndpointId, sourceModel)`
 * pair — what "regenerate this" seeds the model picker with.
 *
 * The two columns are NOT endpoint + upstream halves, which is the natural
 * reading and was the wrong one: every generated row writes `sourceModel` from
 * the relay's `storedModelId`, which is the ALREADY-JOINED `endpointId::
 * upstreamId` id (that's why `friendlyModelName` strips a `::` prefix off it,
 * and why the gallery's `?model=` facet filters on whole internal ids). Joining
 * it to `sourceEndpointId` again produced `bridge::bridge::flux`, which resolves
 * to nothing — so the launch intent's model was silently dropped and the
 * new-chat page fell back to the default, usually a chat model.
 *
 * Still composes when the prefix is absent: `run_python` outputs and OWUI
 * imports store a bare upstream id (or none), and a row that predates the
 * columns has neither.
 */
export function mediaSourceModelId(
	sourceEndpointId: string | null,
	sourceModel: string | null,
): string | null {
	if (!sourceModel) return null;
	if (sourceEndpointId) {
		return sourceModel.startsWith(`${sourceEndpointId}::`)
			? sourceModel
			: `${sourceEndpointId}::${sourceModel}`;
	}
	// No endpoint recorded: usable only if the model id carries its own.
	return endpointIdOf(sourceModel) !== null ? sourceModel : null;
}

/**
 * Convert an internal model id like "bridge::comfyui/ltx-2-3-t2v" into a
 * compact, human-friendly label like "ltx-2-3-t2v" — strips the endpoint
 * prefix and any "owner/" sub-prefix that aggregating bridges add.
 *
 * Used wherever a model is labelled from an id alone: message bubbles, the
 * gallery's model facet, the lightbox header. Doesn't need access to the live
 * upstream `displayName` to be useful — most models embed enough meaning in
 * their slug that the cleaned-up version is fine.
 *
 * Lives here, alongside the grammar it parses, rather than under `$lib/server`
 * where it started: it is pure string work with no server dependency, and the
 * lightbox renders a media row's `sourceModel` on the client, where a
 * `$lib/server` import is not allowed to go.
 */
export function friendlyModelName(internalId: string): string {
	const sep = internalId.indexOf('::');
	const afterEndpoint = sep >= 0 ? internalId.slice(sep + 2) : internalId;
	const slash = afterEndpoint.lastIndexOf('/');
	return slash >= 0 ? afterEndpoint.slice(slash + 1) : afterEndpoint;
}
