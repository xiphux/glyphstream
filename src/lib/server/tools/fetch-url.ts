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

import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { register } from './registry';
import type { Tool, ToolExecution } from './types';
import { composeSignals } from '../util/abort';
import { chunkArticleHtml, chunkPlainText } from '../retrieval/chunker';
import { selectRelevant } from '../retrieval/select';
import { resolveRelevanceConfig } from '../retrieval/embeddings-config';
import { resolveRerankConfig } from '../retrieval/rerank-config';
import {
	assertHostnameRoutable,
	assertHttpScheme,
	assertNotConfiguredBackend,
	isPrivateIp,
} from './url-policy';

const TIMEOUT_MS = 10_000;
// 2 MB body cap. Modern article pages routinely ship 500 KB-1.5 MB of raw
// HTML once you count inline JS, base64 fonts, ad-tech, and comment widgets,
// so a tighter cap forces frequent false-negative fetches before Readability
// even gets a chance to strip them down to the article body. The extracted
// text is still capped at MAX_CONTENT_CHARS below, so the model context can
// never balloon — this cap only protects server memory.
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_CONTENT_CHARS = 20_000;
const MAX_REDIRECTS = 3;

export const fetchUrlTool: Tool = {
	definition: {
		type: 'function',
		function: {
			name: 'fetch_url',
			description:
				'Fetch a single web page or text resource by URL and return its readable contents. Use this after web_search to read a result, or when the user gives you a link. Returns {url, status, content_type, content, mode} as JSON. Refuses non-http(s) URLs and private/loopback/metadata addresses.',
			parameters: {
				type: 'object',
				properties: {
					url: {
						type: 'string',
						description: 'Absolute http(s) URL to fetch.',
					},
					find: {
						type: 'string',
						description:
							'Optional: what you want to learn from this page, in plain words. Only affects long pages — when the readable text exceeds the size budget, the most relevant sections are selected and returned instead of just the first part. Ignored on short pages (the whole page is returned). Use it when you have a SPECIFIC question about a long doc. Do NOT use it for whole-page summary or "what is the overall point" questions — selection returns disjoint sections, so for synthesis/overview omit `find` to get the page in document order.',
					},
				},
				required: ['url'],
				additionalProperties: false,
			},
		},
	},
	metadata: { displayLabel: 'Fetch URL', icon: 'link', category: 'web' },
	async execute(args, ctx): Promise<ToolExecution> {
		const url = parseUrlArg(args);
		if (!url) {
			return errorResult('Missing or invalid `url` argument (expected an absolute http(s) URL).');
		}
		const find = parseFindArg(args);
		try {
			const result = await fetchAndExtract(url, find, ctx.signal);
			return { content: JSON.stringify(result) };
		} catch (e) {
			return errorResult(e instanceof Error ? e.message : String(e));
		}
	},
};

function parseUrlArg(args: unknown): string | null {
	if (!args || typeof args !== 'object' || !('url' in args)) return null;
	const u = (args as { url: unknown }).url;
	return typeof u === 'string' && u.length > 0 ? u : null;
}

/** Optional `find` query: empty/blank/non-string is treated as absent. */
function parseFindArg(args: unknown): string | undefined {
	if (!args || typeof args !== 'object') return undefined;
	const f = (args as { find?: unknown }).find;
	return typeof f === 'string' && f.trim().length > 0 ? f : undefined;
}

function errorResult(message: string): ToolExecution {
	return { content: JSON.stringify({ error: message }), isError: true };
}

interface FetchResult {
	url: string;
	status: number;
	content_type: string;
	content: string;
	/**
	 * How `content` relates to the full page:
	 * - 'full'       — the whole readable text (fit within budget).
	 * - 'truncated'  — over budget, first slice kept (no `find` to select on).
	 * - 'relevance'  — over budget, the sections most relevant to `find`.
	 */
	mode: 'full' | 'truncated' | 'relevance';
}

async function fetchAndExtract(
	initialUrl: string,
	find: string | undefined,
	ctxSignal: AbortSignal,
): Promise<FetchResult> {
	let current: URL;
	try {
		current = new URL(initialUrl);
	} catch {
		throw new Error(`Not a valid URL: ${initialUrl}`);
	}

	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		assertHttpScheme(current);
		assertNotConfiguredBackend(current);
		await assertHostnameRoutable(current.hostname);

		const signal = composeSignals(ctxSignal, AbortSignal.timeout(TIMEOUT_MS));
		const res = await fetch(current, {
			redirect: 'manual',
			signal,
			headers: {
				'user-agent': 'glyphstream',
				accept: 'text/html, text/plain, application/json, text/markdown, */*;q=0.1',
			},
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

		return await processResponse(res, current.href, find, ctxSignal);
	}
	throw new Error(`Exceeded ${MAX_REDIRECTS} redirects.`);
}

async function processResponse(
	res: Response,
	finalUrl: string,
	find: string | undefined,
	ctxSignal: AbortSignal,
): Promise<FetchResult> {
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

	// `text` is the flattened readable view (today's `content` for the full /
	// truncated paths); `structured` retains the article HTML + title so the
	// relevance path can chunk on real heading structure. Non-HTML resources
	// have no structure, so they fall through to the plain-text chunker.
	let text: string;
	let structured: ArticleStructured | null = null;
	if (mime === 'text/html' || mime === 'application/xhtml+xml') {
		structured = extractArticleStructured(raw);
		text = structured ? structured.text : extractTextFromHtml(raw);
	} else {
		// JSON passes through as-is (the model handles minified JSON fine);
		// text/plain & text/markdown likewise.
		text = raw;
	}

	const { content, mode } = await selectOrTruncate(text, structured, find, ctxSignal);

	return {
		url: finalUrl,
		status: res.status,
		content_type: contentType || mime,
		content,
		mode,
	};
}

/**
 * Decide what slice of the readable text to return:
 * - under budget → the whole thing (no chunking, the common case);
 * - over budget, no `find` → head-truncate (preserves prior behavior);
 * - over budget, with `find` → relevance-select over the full body.
 *
 * Relevance is gated on an embedding model being configured, but the BM25 leg
 * runs regardless, so even without embeddings this beats blind truncation.
 */
async function selectOrTruncate(
	text: string,
	structured: ArticleStructured | null,
	find: string | undefined,
	signal: AbortSignal,
): Promise<{ content: string; mode: FetchResult['mode'] }> {
	if (text.length <= MAX_CONTENT_CHARS) {
		return { content: text, mode: 'full' };
	}
	if (!find) {
		return { content: text.slice(0, MAX_CONTENT_CHARS), mode: 'truncated' };
	}

	const chunks =
		structured && structured.contentHtml
			? chunkArticleHtml(structured.contentHtml, structured.title)
			: chunkPlainText(text, structured?.title ?? '');

	// Nothing to choose among — fall back to head-truncation.
	if (chunks.length <= 1) {
		return { content: text.slice(0, MAX_CONTENT_CHARS), mode: 'truncated' };
	}

	const result = await selectRelevant(
		chunks,
		find,
		MAX_CONTENT_CHARS,
		signal,
		resolveRelevanceConfig(),
		resolveRerankConfig(),
	);
	return { content: result.content, mode: result.mode };
}

function parseCharset(contentType: string): string {
	const m = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType);
	return m ? m[1] : 'utf-8';
}

async function readBodyWithCap(res: Response, maxBytes: number, charset: string): Promise<string> {
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

export interface ArticleStructured {
	title: string;
	/** Cleaned article HTML (Readability `content`) — retains heading structure. */
	contentHtml: string;
	/** Flattened title + body text (the value `extractArticleText` returns). */
	text: string;
}

/**
 * Run Mozilla's Readability (the same algorithm Firefox Reader View uses) and
 * return both the flattened text and the cleaned article HTML, or null when
 * the page isn't article-shaped (search results, directory indexes, stubs).
 *
 * The HTML is kept so the relevance chunker can split on real heading
 * structure; the flattened text is what the full/truncated paths return.
 */
export function extractArticleStructured(html: string): ArticleStructured | null {
	try {
		const { document } = parseHTML(html);
		const article = new Readability(document as never).parse();
		const text = article?.textContent?.trim();
		if (text && text.length >= 200) {
			const title = article?.title?.trim() ?? '';
			const body = normalizeWhitespace(text);
			return {
				title,
				contentHtml: article?.content ?? '',
				text: title ? `${title}\n\n${body}` : body,
			};
		}
	} catch {
		// Malformed HTML, parser quirk, or DOM API mismatch — fall through.
	}
	return null;
}

/**
 * Extract readable article text from an HTML document. Thin wrapper over
 * `extractArticleStructured` that falls back to the regex stripper (coarser
 * but always-usable) when Readability can't identify an article. Behavior is
 * unchanged from the original single-function form.
 */
export function extractArticleText(html: string): string {
	return extractArticleStructured(html)?.text ?? extractTextFromHtml(html);
}

function normalizeWhitespace(s: string): string {
	return s
		.replace(/[ \t]+/g, ' ')
		.replace(/ ?\n ?/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

export function extractTextFromHtml(html: string): string {
	let s = html;
	s = s.replace(/<!--[\s\S]*?-->/g, '');
	s = s.replace(
		/<(script|style|head|nav|footer|aside|noscript|template|svg|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
		'',
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
	nbsp: ' ',
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

// `isPrivateIp` continues to be referenced by existing tests via the
// import-from-fetch-url path (and possibly by callers that want the
// pure predicate without a redirect loop). Re-export from the shared
// module so the public surface here stays the same after the refactor.
export { isPrivateIp };

register(fetchUrlTool);
