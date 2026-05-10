/**
 * Convert an internal model id like "bridge::comfyui/ltx-2-3-t2v" into a
 * compact, human-friendly label like "ltx-2-3-t2v" — strips the endpoint
 * prefix and any "owner/" sub-prefix that aggregating bridges add.
 *
 * Used in message bubbles so the assistant is labelled with something
 * recognizable instead of the verbose internal id. Doesn't need access to
 * the live upstream `displayName` to be useful — most models embed enough
 * meaning in their slug that the cleaned-up version is fine.
 */
export function friendlyModelName(internalId: string): string {
	const sep = internalId.indexOf('::');
	const afterEndpoint = sep >= 0 ? internalId.slice(sep + 2) : internalId;
	const slash = afterEndpoint.lastIndexOf('/');
	return slash >= 0 ? afterEndpoint.slice(slash + 1) : afterEndpoint;
}
