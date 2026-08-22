/**
 * Which requests the service worker serves from Cache Storage, and how long it
 * keeps them.
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
 * recently used goes first, which is the right order: it's the previous build's.
 */
export const CHUNK_CACHE_MAX_ENTRIES = 200;

/** A chunk untouched for a month belongs to a build nobody is running. */
export const CHUNK_CACHE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

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
