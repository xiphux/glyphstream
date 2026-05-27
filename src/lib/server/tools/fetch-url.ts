/**
 * `fetch_url` — read a single web page or text resource for the model.
 *
 * Always available (no `isAvailable`); pairs naturally with `web_search`
 * (search returns URLs, fetch reads them) but is independently useful
 * when the user pastes a link in chat.
 *
 * SSRF guard (block-by-default): rejects non-http(s) schemes, and any
 * hostname whose DNS resolution lands in private / loopback / link-local
 * / cloud-metadata / multicast space — including across HTTP redirects.
 * There's an unavoidable TOCTOU window between our DNS lookup and the
 * actual socket connect (a DNS-rebinding attacker could swap addresses),
 * but the goal here is to defeat the common-case "model hallucinates an
 * internal URL or follows a redirect into the LAN" path, which it does.
 *
 * Content types: text/html -> extracted to plain text; text/plain &
 * text/markdown -> pass-through; application/json -> re-stringified;
 * anything else -> isError so the model gets clear in-band feedback.
 * Body capped at 256 KB, extracted text truncated to ~20 KB.
 */

import dns from 'node:dns';
import { register } from './registry';
import type { Tool, ToolExecution } from './types';
import { composeSignals } from '../util/abort';

const TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_CONTENT_CHARS = 20_000;
const MAX_REDIRECTS = 3;

export const fetchUrlTool: Tool = {
	definition: {
		type: 'function',
		function: {
			name: 'fetch_url',
			description:
				'Fetch a single web page or text resource by URL and return its readable contents. Use this after web_search to read a result, or when the user gives you a link. Returns {url, status, content_type, content} as JSON. Refuses non-http(s) URLs and private/loopback/metadata addresses.',
			parameters: {
				type: 'object',
				properties: {
					url: {
						type: 'string',
						description: 'Absolute http(s) URL to fetch.'
					}
				},
				required: ['url'],
				additionalProperties: false
			}
		}
	},
	metadata: { displayLabel: 'Fetch URL', icon: 'link' },
	async execute(args, ctx): Promise<ToolExecution> {
		const url = parseUrlArg(args);
		if (!url) {
			return errorResult('Missing or invalid `url` argument (expected an absolute http(s) URL).');
		}
		try {
			const result = await fetchAndExtract(url, ctx.signal);
			return { content: JSON.stringify(result) };
		} catch (e) {
			return errorResult(e instanceof Error ? e.message : String(e));
		}
	}
};

function parseUrlArg(args: unknown): string | null {
	if (!args || typeof args !== 'object' || !('url' in args)) return null;
	const u = (args as { url: unknown }).url;
	return typeof u === 'string' && u.length > 0 ? u : null;
}

function errorResult(message: string): ToolExecution {
	return { content: JSON.stringify({ error: message }), isError: true };
}

interface FetchResult {
	url: string;
	status: number;
	content_type: string;
	content: string;
	truncated?: boolean;
}

async function fetchAndExtract(initialUrl: string, ctxSignal: AbortSignal): Promise<FetchResult> {
	let current: URL;
	try {
		current = new URL(initialUrl);
	} catch {
		throw new Error(`Not a valid URL: ${initialUrl}`);
	}

	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		if (current.protocol !== 'http:' && current.protocol !== 'https:') {
			throw new Error(
				`Refused scheme "${current.protocol}" - only http(s) URLs are allowed.`
			);
		}
		await assertNotPrivate(current.hostname);

		const signal = composeSignals(ctxSignal, AbortSignal.timeout(TIMEOUT_MS));
		const res = await fetch(current, {
			redirect: 'manual',
			signal,
			headers: {
				'user-agent': 'glyphstream',
				accept: 'text/html, text/plain, application/json, text/markdown, */*;q=0.1'
			}
		});

		if (res.status >= 300 && res.status < 400) {
			const loc = res.headers.get('location');
			await res.body?.cancel().catch(() => {});
			if (!loc) throw new Error(`HTTP ${res.status} redirect without a Location header.`);
			if (hop >= MAX_REDIRECTS) throw new Error(`Exceeded ${MAX_REDIRECTS} redirects.`);
			try {
				current = new URL(loc, current);
			} catch {
				throw new Error(`Redirect Location "${loc}" is not a valid URL.`);
			}
			continue;
		}

		return await processResponse(res, current.href);
	}
	throw new Error(`Exceeded ${MAX_REDIRECTS} redirects.`);
}

async function processResponse(res: Response, finalUrl: string): Promise<FetchResult> {
	const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
	const mime = contentType.split(';')[0].trim();

	if (
		mime !== 'text/html' &&
		mime !== 'application/xhtml+xml' &&
		mime !== 'application/json' &&
		!mime.startsWith('text/')
	) {
		await res.body?.cancel().catch(() => {});
		throw new Error(`Unsupported content-type: ${mime || '(missing)'}`);
	}

	const raw = await readBodyWithCap(res, MAX_BODY_BYTES, parseCharset(contentType));

	let content: string;
	if (mime === 'text/html' || mime === 'application/xhtml+xml') {
		content = extractTextFromHtml(raw);
	} else if (mime === 'application/json') {
		try {
			content = JSON.stringify(JSON.parse(raw), null, 2);
		} catch {
			content = raw;
		}
	} else {
		content = raw;
	}

	const truncated = content.length > MAX_CONTENT_CHARS;
	if (truncated) content = content.slice(0, MAX_CONTENT_CHARS);

	return {
		url: finalUrl,
		status: res.status,
		content_type: contentType || mime,
		content,
		...(truncated ? { truncated: true } : {})
	};
}

function parseCharset(contentType: string): string {
	const m = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType);
	return m ? m[1] : 'utf-8';
}

async function readBodyWithCap(
	res: Response,
	maxBytes: number,
	charset: string
): Promise<string> {
	if (!res.body) return '';
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel().catch(() => {});
				throw new Error(`Response body exceeded ${maxBytes} bytes.`);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock?.();
	}
	const buf = concat(chunks);
	try {
		return new TextDecoder(charset).decode(buf);
	} catch {
		return new TextDecoder('utf-8').decode(buf);
	}
}

function concat(arrs: Uint8Array[]): Uint8Array {
	let total = 0;
	for (const a of arrs) total += a.byteLength;
	const out = new Uint8Array(total);
	let off = 0;
	for (const a of arrs) {
		out.set(a, off);
		off += a.byteLength;
	}
	return out;
}

export function extractTextFromHtml(html: string): string {
	let s = html;
	s = s.replace(/<!--[\s\S]*?-->/g, '');
	s = s.replace(
		/<(script|style|head|nav|footer|aside|noscript|template|svg|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
		''
	);
	s = s.replace(/<(?:br|hr)\s*\/?>/gi, '\n');
	s = s.replace(/<\/(?:p|div|li|tr|h[1-6]|section|article|header|blockquote|pre)\s*>/gi, '\n\n');
	s = s.replace(/<\/(?:td|th)\s*>/gi, '\t');
	s = s.replace(/<\/?[^>]+>/g, ' ');
	s = decodeEntities(s);
	s = s.replace(/[ \t]+/g, ' ');
	s = s.replace(/ ?\n ?/g, '\n');
	s = s.replace(/\n{3,}/g, '\n\n');
	return s.trim();
}

const NAMED_ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' '
};

function decodeEntities(s: string): string {
	return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, code: string) => {
		if (code[0] === '#') {
			const cp =
				code[1] === 'x' || code[1] === 'X'
					? parseInt(code.slice(2), 16)
					: parseInt(code.slice(1), 10);
			return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
		}
		const named = NAMED_ENTITIES[code.toLowerCase()];
		return named ?? m;
	});
}

async function assertNotPrivate(hostname: string): Promise<void> {
	const addrs = await dns.promises.lookup(hostname, { all: true });
	for (const a of addrs) {
		if (isPrivateIp(a.address)) {
			throw new Error(
				`Refused: ${hostname} resolves to private/reserved address ${a.address}.`
			);
		}
	}
}

/**
 * Returns true for IPv4 / IPv6 addresses in private, loopback, link-local,
 * CGNAT, benchmark, multicast, reserved, or cloud-metadata ranges. Used as
 * a coarse SSRF allowlist - block by default; let only globally-routable
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

register(fetchUrlTool);
