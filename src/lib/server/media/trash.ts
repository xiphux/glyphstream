/**
 * How long deleted media stays in "Recently deleted" before the purger unlinks
 * its bytes for good. Hardcoded like the purger's other cadences: it is a
 * safety net for a mis-tap, and 30 days is the convention users already know
 * from their phones' photo apps.
 */
export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Whether the bytes endpoints (/content, /thumbnail) should serve this row.
 *
 * A trashed row is served ONLY when the request asks for it with `?trash=1` —
 * which only the "Recently deleted" page does. Without the opt-in, a gallery
 * delete would leave the image rendering in every conversation that showed it
 * for another 30 days, when the user's expectation (and the pre-trash
 * behaviour) is that it's gone. A distinct URL also keeps the immutable cache
 * entry for the live URL from vouching for a deleted asset's bytes and vice
 * versa.
 */
export function servableForRequest(
	row: { deletedAt: number | null; purgedAt: number | null },
	url: URL,
): boolean {
	if (url.searchParams.get('trash') === '1') {
		return row.deletedAt !== null && row.purgedAt === null;
	}
	return row.deletedAt === null;
}
