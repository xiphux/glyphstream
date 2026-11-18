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
 * The same filter runs again on the lookup the socket connects with
 * (`fetchRoutable`), so DNS rebinding can't swap in a private
 * address between the check and the connect.
 *
 * Content types: text/html -> extracted to plain text; text/plain &
 * text/markdown -> pass-through; application/json -> re-stringified;
 * anything else -> isError so the model gets clear in-band feedback.
 * Body capped at 2 MB, extracted text capped at 20K chars.
 */

import { register } from './registry';
import type { Tool, ToolExecution } from './types';
import { composeSignals } from '../util/abort';
import { chunkPlainText, type Chunk } from '../retrieval/chunker';
import { extractInWorker } from './extract-in-worker';
import { selectRelevant } from '../retrieval/select';
import { resolveRelevanceConfig } from '../retrieval/embeddings-config';
import { resolveRerankConfig } from '../retrieval/rerank-config';
import {
	assertHostnameRoutable,
	assertHttpScheme,
	assertNotConfiguredBackend,
	isPrivateIp,
	fetchRoutable,
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
				'Fetch a web page or text resource and return its readable contents. Use after web_search to read a result, or when the user gives you a link. Returns {url, status, content_type, content, mode} as JSON. When mode is "relevance" it also returns `sections` (the headings returned) and `outline` (every heading in the page) — if the answer wasn\'t in `content`, re-fetch with a different `find` aimed at a section from `outline`. Refuses non-http(s), private, loopback, and metadata addresses.',
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
							'Optional: what you want from this page, in plain words. Only affects pages too long to return whole, where it selects the most relevant sections instead of just the opening. Use it for a SPECIFIC question; omit it for a summary or overall-point question, since the sections it returns are disjoint and out of document order.',
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
	const u = args.url;
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

export interface FetchResult {
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
	/**
	 * On `mode: 'relevance'` only: the section breadcrumb trails actually returned
	 * in `content` (`sections`) and every section in the full document
	 * (`outline`). The model can re-fetch with a different `find` to pull a
	 * section in `outline` that selection didn't return. Omitted on the
	 * full/truncated paths, and when the page carries no heading structure.
	 */
	sections?: string[];
	outline?: string[];
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
		const res = await fetchRoutable(current, {
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

	// `text` is the flattened readable view (the `content` of the full /
	// truncated paths). For an article page, the worker also hands back the
	// article HTML's heading-aware chunks when the relevance path will want
	// them. Non-HTML resources have no structure, so they fall through to the
	// plain-text chunker.
	let text: string;
	let title = '';
	let htmlChunks: Chunk[] | null = null;
	if (mime === 'text/html' || mime === 'application/xhtml+xml') {
		const page = await extractInWorker(
			{ html: raw, chunkOver: find ? MAX_CONTENT_CHARS : null },
			ctxSignal,
		);
		({ text, title, chunks: htmlChunks } = page);
	} else {
		// JSON passes through as-is (the model handles minified JSON fine);
		// text/plain & text/markdown likewise.
		text = raw;
	}

	const { content, mode, sections, outline } = await selectOrTruncate(
		text,
		title,
		htmlChunks,
		find,
		ctxSignal,
	);

	return {
		url: finalUrl,
		status: res.status,
		content_type: contentType || mime,
		content,
		mode,
		...(sections && sections.length > 0 ? { sections } : {}),
		...(outline && outline.length > 0 ? { outline } : {}),
	};
}

/**
 * Decide what slice of the readable text to return:
 * - under budget → the whole thing (no chunking, the common case);
 * - over budget, no `find` → head-truncate;
 * - over budget, with `find` → relevance-select over the full body.
 *
 * Relevance is gated on an embedding model being configured, but the BM25 leg
 * runs regardless, so even without embeddings this beats blind truncation.
 */
async function selectOrTruncate(
	text: string,
	title: string,
	htmlChunks: Chunk[] | null,
	find: string | undefined,
	signal: AbortSignal,
): Promise<{
	content: string;
	mode: FetchResult['mode'];
	sections?: string[];
	outline?: string[];
}> {
	if (text.length <= MAX_CONTENT_CHARS) {
		return { content: text, mode: 'full' };
	}
	if (!find) {
		return { content: text.slice(0, MAX_CONTENT_CHARS), mode: 'truncated' };
	}

	const chunks = htmlChunks ?? chunkPlainText(text, title);

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
	return {
		content: result.content,
		mode: result.mode,
		sections: result.sections,
		outline: result.outline,
	};
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

// Tests import the pure predicate and the extractors from here.
export { isPrivateIp };
export { extractArticleStructured, extractTextFromHtml } from './html-extract';

register(fetchUrlTool);
