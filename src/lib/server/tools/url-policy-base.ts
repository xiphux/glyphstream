/**
 * URL-policy primitives that are PURE (no SvelteKit env / config.toml /
 * `$env/dynamic/private` dependencies). Lives in its own module so the
 * code-interpreter worker — which is bundled standalone via esbuild and
 * loaded by node:worker_threads outside Vite's transform pipeline — can
 * import these without dragging in the env layer.
 *
 * The full `url-policy.ts` re-exports everything here AND layers on
 * `assertNotConfiguredBackend`, which uses `loadEndpoints` / `loadSearchConfig`
 * from the SvelteKit-aware endpoints/config module. Callers in the main
 * SvelteKit code path should keep importing from `url-policy.ts`; only the
 * worker reaches into this base.
 */

import dns from 'node:dns';

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
