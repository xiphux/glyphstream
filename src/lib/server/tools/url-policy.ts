/**
 * Shared URL policy for every server-side outbound path that forwards a
 * model-controlled URL. Today's callers: `fetch_url`, and (incoming with
 * the code interpreter) the Pyodide worker's global `fetch` shim. Future
 * callers — any tool that emits HTTP from inside the Node process based
 * on model-supplied input — should route through here so the
 * "what we refuse and why" answer lives in exactly one place.
 *
 * Three classes of refusal, applied in order:
 *
 *  1. **Scheme.** Only `http:` and `https:` are accepted. Refusing
 *     `file:` / `data:` / `gopher:` / etc. closes off the most direct
 *     class of trick where the model emits a non-network URL hoping for
 *     a local read.
 *
 *  2. **SSRF.** After DNS resolution, every returned address is checked
 *     against the private-IP table (`isPrivateIp`). Any private,
 *     loopback, link-local, CGNAT, benchmark, cloud-metadata, multicast,
 *     or reserved address fails closed. Re-runs on every redirect hop
 *     (callers loop with `redirect: 'manual'`) so a public destination
 *     can't redirect into the LAN.
 *
 *  3. **Configured backends.** Refuses any host explicitly configured as
 *     an upstream LLM endpoint (`[[endpoints]]`) or as the SearxNG
 *     instance (`[search]`). Even on a properly-configured public
 *     backend the model has no legitimate reason to call it via a tool —
 *     that path goes through the streaming relay with proper auth and
 *     accounting. This is the "model can't end-around its own backend"
 *     guard the user called out: disabling `web` for the conversation
 *     also blocks the conversation's bridge, and the model can't fish
 *     for a SearxNG admin endpoint by pasting its URL.
 *
 * Inputs are model-controlled, so all errors throw `UrlPolicyError` with
 * messages safe to surface back to the model (no internal-state leaks).
 *
 * Module split: the pure (env-free) parts live in `url-policy-base.ts`
 * so the code-interpreter worker — bundled standalone via esbuild outside
 * the SvelteKit transform pipeline — can import them without dragging
 * `$env/dynamic/private` along. This file adds the env-using
 * `assertNotConfiguredBackend` and the forbidden-host accessor used by
 * the pool to pass the set into the worker at init.
 */

import { loadEndpoints, loadSearchConfig } from '../endpoints/config';
import { UrlPolicyError } from './url-policy-base';

export {
	UrlPolicyError,
	assertHttpScheme,
	assertHostnameRoutable,
	isPrivateIp,
} from './url-policy-base';

/**
 * Refuse URLs whose hostname matches any configured upstream LLM endpoint
 * (`[[endpoints]]` in config.toml) or the SearxNG instance (`[search]`).
 * The model has no legitimate reason to reach those via a tool — the
 * streaming relay is the only authorized caller and it goes through
 * auth + accounting layers a tool call would bypass.
 *
 * Match key is the URL hostname (normalized to lowercase). We don't try
 * to compare ports — a configured bridge at `internal:8080` is
 * effectively "this hostname is internal" regardless of port, since
 * other ports on the same host are likely sibling internal services
 * (a Redis on 6379, a metrics endpoint on 9100, ...) that the model
 * shouldn't be able to reach either.
 *
 * The forbidden host set is built lazily on first call from
 * `loadEndpoints()` + `loadSearchConfig()`. Config is loaded once at boot
 * and doesn't reload at runtime in v1, so the cached set is stable for
 * the process lifetime. Tests can call `resetUrlPolicyCacheForTests()`
 * to drop the cache between scenarios.
 */
export function assertNotConfiguredBackend(url: URL): void {
	const forbidden = getForbiddenHosts();
	const host = url.hostname.toLowerCase();
	if (forbidden.has(host)) {
		throw new UrlPolicyError(
			`Refused: ${host} is a configured backend (an upstream LLM or search endpoint); the model is not allowed to reach it through tool calls.`,
		);
	}
}

let cachedForbiddenHosts: Set<string> | null = null;

function getForbiddenHosts(): Set<string> {
	if (cachedForbiddenHosts) return cachedForbiddenHosts;
	const set = new Set<string>();
	try {
		for (const ep of loadEndpoints()) {
			try {
				set.add(new URL(ep.baseUrl).hostname.toLowerCase());
			} catch {
				// Skip malformed entries — loadEndpoints validates `base_url`
				// at boot, so this is defense-in-depth more than a real
				// branch.
			}
		}
	} catch {
		// If config can't be loaded, treat the forbidden set as empty —
		// callers higher up will still hit other failures during their
		// own config-dependent paths, and we don't want to turn a
		// startup config error into "every fetch refuses".
	}
	try {
		const search = loadSearchConfig();
		if (search) {
			try {
				set.add(new URL(search.url).hostname.toLowerCase());
			} catch {
				// Same defense-in-depth as above.
			}
		}
	} catch {
		// Same as above.
	}
	cachedForbiddenHosts = set;
	return set;
}

/**
 * Snapshot of the forbidden-host set for callers that need to ship it
 * across a process boundary — specifically, the code-interpreter pool
 * passes this list to its workers at init time so the worker's network
 * shim can apply the same check without itself needing the SvelteKit
 * env / config layer (which doesn't bundle cleanly into a standalone
 * worker via esbuild). Returns a fresh array; mutating it has no effect
 * on the cached set.
 */
export function listForbiddenHosts(): string[] {
	return Array.from(getForbiddenHosts());
}

/** Test-only: drop the cached forbidden-hosts set so the next call
 *  re-reads from a freshly-mocked `loadEndpoints` / `loadSearchConfig`. */
export function resetUrlPolicyCacheForTests(): void {
	cachedForbiddenHosts = null;
}
