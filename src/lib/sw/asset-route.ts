/**
 * Which requests the service worker serves from Cache Storage, and how many of
 * them it keeps. Deliberately not how LONG — see the note on the entry cap.
 *
 * Split out from the worker itself so the predicate is a pure function a node
 * test can exercise — the worker is built in its own Vite pass with worker
 * globals and is not reachable from the app's test program.
 *
 * Why the worker caches these at all, given the config already declines to
 * PRECACHE them: the two are different mechanisms. Precaching downloads a fixed
 * list at install time, which swept in route-lazy chunks a user may never open
 * and re-installed a large slice of the graph on every deploy. Runtime caching
 * stores only what the app actually fetched, so nothing is downloaded early and
 * a deploy costs only the chunks that get used.
 *
 * The reason it's needed is measured, not theoretical. These assets are already
 * served `max-age=31536000, immutable`, and the assumption was that the
 * browser's own HTTP cache would cover repeat loads. On an iOS home-screen app
 * it does not: the debug panel reported 41 of 41 chunks coming from the network
 * on three consecutive cold launches of an unchanged build, hours apart. WebKit
 * does not reliably keep a standalone web app's disk cache across termination.
 * Cache Storage is explicit, app-owned, and survives.
 */

/** Content-hashed build output. Everything under here is immutable by construction. */
export const IMMUTABLE_PREFIX = '/_app/immutable/';

export const CHUNK_CACHE_NAME = 'glyphstream-app-chunks';

/**
 * Roughly two builds' worth (~89 entries each), so a deploy can land without
 * evicting the chunks the still-open page is running from. Past that, least
 * recently used goes first — genuinely last-used, off workbox's IndexedDB
 * timestamp — which is the right order: it's the previous build's.
 */
export const CHUNK_CACHE_MAX_ENTRIES = 200;

// There is deliberately no `maxAgeSeconds` companion to the entry cap, and it is
// worth saying why, because adding one reads as obvious housekeeping.
//
// Workbox does not gate a hit on when an entry was last USED — its
// `cachedResponseWillBeUsed` computes freshness from the cached response's
// `Date` header, the wall-clock moment it was first fetched, and forces a miss
// past the limit however recently it was served. The last-used timestamp only
// drives eviction; it never rescues an entry the date check rejected. So any
// value here is a scheduled re-download of the whole bundle on that cadence, for
// every user — precisely the thing this route exists to stop, and worst on a
// self-hosted box running one build for months. It also makes the worker refuse
// to serve bytes it physically holds when the network is down and the entry has
// aged out.
//
// Content-hashed URLs cannot go stale, so age bounds nothing worth bounding.
// The entry cap above is the only limit, and it evicts on last use.

/**
 * True for the hashed client bundle, and nothing else.
 *
 * Deliberately narrower than `/_app/`: `/_app/version.json` lives there too and
 * is what SvelteKit polls to notice a new deploy. Serving that from a
 * cache-first route would pin the app to the version it first saw and quietly
 * disable update detection — the failure would look like "updates stopped
 * working" with nothing in the logs.
 */
export function isImmutableAsset({ url, sameOrigin }: { url: URL; sameOrigin: boolean }): boolean {
	return sameOrigin && url.pathname.startsWith(IMMUTABLE_PREFIX);
}
