/**
 * URL-policy primitives that are PURE (no env / config.toml dependencies).
 * Lives in its own module so the
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
import type { LookupAddress } from 'node:dns';
import { Agent } from 'undici';

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
 * This check alone is not enough: `fetch` resolves the name again when it
 * connects, and a DNS-rebinding server can answer the second lookup with a
 * private address. So every caller ALSO fetches through {@link fetchRoutable},
 * which applies the same filter to the
 * lookup the socket actually uses. This early check stays because it gives a
 * clear refusal message before any connection is attempted.
 */
export async function assertHostnameRoutable(hostname: string): Promise<void> {
	// A URL's hostname keeps the brackets around an IPv6 literal. Judge the
	// literal itself; DNS would only fail on the bracketed form, refusing
	// every IPv6 URL, public ones included, for the wrong reason.
	const literal = /^\[(.*)\]$/.exec(hostname)?.[1];
	if (literal !== undefined) {
		if (isPrivateIp(literal)) {
			throw new UrlPolicyError(`Refused: ${hostname} is a private/reserved address.`);
		}
		return;
	}
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
 * Lowercase a URL hostname and drop a trailing root dot. `api.example.com.`
 * names the same host as `api.example.com`, so a comparison against a set of
 * configured hostnames has to see them as equal.
 */
export function normalizeHostname(hostname: string): string {
	return hostname.toLowerCase().replace(/\.$/, '');
}

type LookupCallback = (
	err: NodeJS.ErrnoException | null,
	address: string | LookupAddress[],
	family?: number,
) => void;

/**
 * A `connect.lookup` that resolves like the default and then refuses the
 * connection when any resolved address is private. Because the socket
 * connects to what this returns, the address that was checked is the
 * address that is used, which closes the DNS-rebinding window that a
 * check-then-fetch leaves open.
 */
function routableOnlyLookup(
	hostname: string,
	options: dns.LookupOptions,
	callback: LookupCallback,
): void {
	dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
		if (err) return callback(err, []);
		const bad = addrs.find((a) => isPrivateIp(a.address));
		if (bad) {
			return callback(
				new UrlPolicyError(
					`Refused: ${hostname} resolves to private/reserved address ${bad.address}.`,
				),
				[],
			);
		}
		if (addrs.length === 0) {
			const e: NodeJS.ErrnoException = new Error(`No addresses for ${hostname}`);
			e.code = 'ENOTFOUND';
			return callback(e, []);
		}
		if (options.all) return callback(null, addrs);
		callback(null, addrs[0].address, addrs[0].family);
	});
}

let routableDispatcher: Agent | undefined;

/**
 * `fetch` for every URL that came from an untrusted source (a model's tool
 * call, Python in the interpreter, an upstream's media URL). It connects only
 * to publicly routable addresses; see {@link assertHostnameRoutable} for why
 * the early check isn't enough on its own.
 *
 * An IP-literal host never reaches the lookup, so callers must still run
 * `assertHostnameRoutable` first; it rejects private literals.
 */
export function fetchRoutable(input: string | URL, init: RequestInit): Promise<Response> {
	routableDispatcher ??= new Agent({ connect: { lookup: routableOnlyLookup } });
	// The DOM `RequestInit` the app type-checks against has no `dispatcher`;
	// Node's fetch reads it.
	return fetch(input, { ...init, dispatcher: routableDispatcher } as RequestInit);
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

	const h = expandIpv6(cleaned);
	if (!h) return true; // unparseable -> fail closed
	const [h0, h1, h2, h3, h4, h5, h6, h7] = h;
	const embedded = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
	// Addresses that carry an IPv4 address inside them are judged by that
	// address. The URL parser always writes a mapped address in hex
	// (`[::ffff:127.0.0.1]` becomes `::ffff:7f00:1`), so the dotted check
	// above never sees it.
	if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0) {
		// ::/128 unspecified and ::1 loopback; the rest of ::/96 is the
		// deprecated IPv4-compatible form; ::ffff:0:0/96 is IPv4-mapped.
		if (h5 === 0 && h6 === 0 && (h7 === 0 || h7 === 1)) return true;
		if (h5 === 0 || h5 === 0xffff) return isPrivateIp(embedded(h6, h7));
		return true;
	}
	// 64:ff9b::/96 well-known NAT64 prefix: a NAT64 gateway forwards to the
	// embedded IPv4, so 64:ff9b::a9fe:a9fe reaches 169.254.169.254.
	if (h0 === 0x64 && h1 === 0xff9b && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0) {
		return isPrivateIp(embedded(h6, h7));
	}
	if (h0 === 0x64 && h1 === 0xff9b && h2 === 1) return true; // 64:ff9b:1::/48 local NAT64
	if (h0 === 0x2002) return isPrivateIp(embedded(h1, h2)); // 2002::/16 6to4
	if (h0 === 0x2001 && h1 === 0) return true; // 2001::/32 Teredo (obfuscated IPv4)
	if (h0 === 0x2001 && h1 === 0xdb8) return true; // 2001:db8::/32 documentation
	if ((h0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
	if ((h0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
	if ((h0 & 0xffc0) === 0xfec0) return true; // fec0::/10 deprecated site-local
	if ((h0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
	return false;
}

/**
 * Expand an IPv6 address (optionally ending in a dotted IPv4) to its eight
 * 16-bit groups, or null if it isn't one. Classifying the expanded form means
 * every spelling of an address (`::1`, `0:0:0:0:0:0:0:1`, `0::0:1`) is judged
 * the same way.
 */
function expandIpv6(ip: string): number[] | null {
	let s = ip.toLowerCase();
	const tail: number[] = [];
	const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
	if (dotted) {
		const parts = dotted[2].split('.').map(Number);
		if (parts.some((n) => n > 255)) return null;
		tail.push((parts[0] << 8) | parts[1], (parts[2] << 8) | parts[3]);
		s = dotted[1].endsWith('::') ? dotted[1] : dotted[1].slice(0, -1);
	}
	const halves = s.split('::');
	if (halves.length > 2) return null;
	const parse = (part: string): number[] | null => {
		if (part === '') return [];
		const groups = part.split(':');
		if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
		return groups.map((g) => parseInt(g, 16));
	};
	const head = parse(halves[0]);
	const rest = halves.length === 2 ? parse(halves[1]) : [];
	if (!head || !rest) return null;
	const known = head.length + rest.length + tail.length;
	if (halves.length === 1) return known === 8 ? [...head, ...tail] : null;
	if (known > 7) return null;
	return [...head, ...new Array<number>(8 - known).fill(0), ...rest, ...tail];
}
