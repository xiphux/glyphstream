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
 */

import dns from 'node:dns';
import { loadEndpoints, loadSearchConfig } from '../endpoints/config';

export class UrlPolicyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'UrlPolicyError';
	}
}

export function assertHttpScheme(url: URL): void {
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new UrlPolicyError(`Refused scheme "${url.protocol}" - only http(s) URLs are allowed.`);
	}
}

/**
 * DNS-resolve `hostname` and refuse if any returned address is private/
 * reserved. Runs the loopback / link-local / CGNAT / cloud-metadata /
 * multicast filter via `isPrivateIp`. Callers using `redirect: 'manual'`
 * should call this on every hop so a public→private redirect is
 * caught at the same gate as the initial address.
 *
 * There's an unavoidable TOCTOU window between the DNS lookup here and
 * the actual socket connect — a DNS-rebinding attacker could swap
 * addresses in between. The goal here is to defeat the common-case
 * "model emits an internal URL or follows a redirect into the LAN"
 * path, which it does. Hardening against DNS rebinding requires socket-
 * level address pinning, which is out of scope for v1.
 */
export async function assertHostnameRoutable(hostname: string): Promise<void> {
	const addrs = await dns.promises.lookup(hostname, { all: true });
	for (const a of addrs) {
		if (isPrivateIp(a.address)) {
			throw new UrlPolicyError(
				`Refused: ${hostname} resolves to private/reserved address ${a.address}.`,
			);
		}
	}
}

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

/** Test-only: drop the cached forbidden-hosts set so the next call
 *  re-reads from a freshly-mocked `loadEndpoints` / `loadSearchConfig`. */
export function resetUrlPolicyCacheForTests(): void {
	cachedForbiddenHosts = null;
}

/**
 * Returns true for IPv4 / IPv6 addresses in private, loopback, link-local,
 * CGNAT, benchmark, multicast, reserved, or cloud-metadata ranges. Used as
 * a coarse SSRF allowlist — block by default; let only globally-routable
 * unicast addresses through.
 *
 * Unparseable inputs are treated as private (fail-closed).
 */
export function isPrivateIp(ip: string): boolean {
	if (!ip) return true;
	const cleaned = ip.split('%')[0];

	const v4 = cleaned.includes('.')
		? cleaned.startsWith('::ffff:')
			? cleaned.slice('::ffff:'.length)
			: cleaned
		: null;
	if (v4 !== null) {
		const parts = v4.split('.');
		if (parts.length !== 4) return true;
		const nums = parts.map((p) => Number(p));
		if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
		const [a, b] = nums;
		if (a === 0) return true; // 0.0.0.0/8
		if (a === 10) return true; // 10.0.0.0/8
		if (a === 127) return true; // loopback 127.0.0.0/8
		if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local + AWS metadata)
		if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
		if (a === 192 && b === 168) return true; // 192.168.0.0/16
		if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
		if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 (benchmark)
		if (a >= 224) return true; // 224.0.0.0/4 (multicast) + 240.0.0.0/4 (reserved)
		return false;
	}

	if (!cleaned.includes(':')) return true; // not an IP literal at all -> fail closed

	const lower = cleaned.toLowerCase();
	if (lower === '::' || lower === '::1') return true;
	// fc00::/7 - unique local addresses (first byte fc or fd)
	if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;
	// fe80::/10 - link-local (first 10 bits 1111111010 -> first byte fe + nibble 8/9/a/b)
	if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;
	// ff00::/8 - multicast
	if (/^ff[0-9a-f]{2}:/.test(lower)) return true;
	return false;
}
