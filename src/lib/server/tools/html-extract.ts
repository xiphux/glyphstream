/**
 * The CPU-heavy half of `fetch_url`: HTML in, readable text (and, when the
 * relevance path will need them, heading-aware chunks) out.
 *
 * Pure and synchronous, importing nothing but linkedom, Readability and the
 * chunker, because it runs inside `fetch-extract-worker.ts` — a worker thread
 * esbuild bundles on its own. linkedom + Readability are superlinear in the
 * nesting depth of unclosed elements (64 KB of `<div>` takes the better part
 * of a minute), so this must never run on the server's event loop; see
 * `extract-in-worker.ts`.
 */

import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { chunkArticleHtml, type Chunk } from '../retrieval/chunker';

export interface ArticleStructured {
	title: string;
	/** Cleaned article HTML (Readability `content`) — retains heading structure. */
	contentHtml: string;
	/** Flattened title + body text. */
	text: string;
}

export interface ExtractRequest {
	html: string;
	/**
	 * Build heading-aware chunks when the extracted text is longer than this
	 * many chars; null when the caller won't relevance-select (no `find`).
	 */
	chunkOver: number | null;
}

export interface ExtractedPage {
	/** Readable text: Readability's article when it finds one, else the tag-stripped page. */
	text: string;
	/** Article title, '' when Readability found no article. */
	title: string;
	/**
	 * Chunks of the article HTML, or null when not requested, under
	 * `chunkOver`, or there is no article HTML — the caller then chunks
	 * `text` as plain text.
	 */
	chunks: Chunk[] | null;
}

export function extractPage({ html, chunkOver }: ExtractRequest): ExtractedPage {
	const structured = extractArticleStructured(html);
	const text = structured ? structured.text : extractTextFromHtml(html);
	const chunks =
		chunkOver !== null && text.length > chunkOver && structured?.contentHtml
			? chunkArticleHtml(structured.contentHtml, structured.title)
			: null;
	return { text, title: structured?.title ?? '', chunks };
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
		const article = new Readability(document).parse();
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

function normalizeWhitespace(s: string): string {
	return s
		.replace(/[ \t]+/g, ' ')
		.replace(/ ?\n ?/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/**
 * Tag-stripping fallback for pages Readability finds no article in.
 *
 * Every pass is linear in the input. The comment, skipped-element and
 * tag-strip passes are hand-written scans rather than the regexes they
 * replace (`<!--[\s\S]*?-->`, `<(script|…)\b[^>]*>[\s\S]*?<\/\1\s*>`,
 * `<\/?[^>]+>`) with the same matches: each of those regexes rescans to the
 * end of the input from every unterminated opener, so a page of nothing but
 * `<!--` or `<svg ` was quadratic in its size.
 */
export function extractTextFromHtml(html: string): string {
	let s = html;
	s = stripComments(s);
	s = stripSkippedElements(s);
	s = s.replace(/<(?:br|hr)\s*\/?>/gi, '\n');
	s = s.replace(/<\/(?:p|div|li|tr|h[1-6]|section|article|header|blockquote|pre)\s*>/gi, '\n\n');
	s = s.replace(/<\/(?:td|th)\s*>/gi, '\t');
	s = replaceTags(s, ' ');
	s = decodeEntities(s);
	s = s.replace(/[ \t]+/g, ' ');
	s = s.replace(/ ?\n ?/g, '\n');
	s = s.replace(/\n{3,}/g, '\n\n');
	return s.trim();
}

/** Remove every `<!-- … -->`. An unterminated `<!--` leaves the rest as-is. */
function stripComments(s: string): string {
	const out: string[] = [];
	let pos = 0;
	for (;;) {
		const open = s.indexOf('<!--', pos);
		if (open < 0) break;
		const close = s.indexOf('-->', open + 4);
		// No `-->` after this opener means none after any later one either.
		if (close < 0) break;
		out.push(s.slice(pos, open));
		pos = close + 3;
	}
	out.push(s.slice(pos));
	return out.join('');
}

const SKIPPED_NAME = /(script|style|head|nav|footer|aside|noscript|template|svg|iframe)\b/iy;

/**
 * Remove each `<name …>…</name>` whose name is in SKIPPED_NAME (matched
 * case-insensitively, first closer wins, no nesting), keeping an opener with
 * no `>` or no closer.
 *
 * The next `>` and each name's next closer are memoized: both are searched
 * for from positions that only move forward, so a found position still at or
 * past the new start is still the first one — and a miss is a miss for every
 * later start. That is what keeps a run of unterminated openers linear.
 */
function stripSkippedElements(s: string): string {
	const out: string[] = [];
	const gt = forwardIndexOf(s, '>');
	const closers = new Map<string, (from: number) => number>();
	let kept = 0;
	let lt = s.indexOf('<');
	while (lt >= 0) {
		SKIPPED_NAME.lastIndex = lt + 1;
		const m = SKIPPED_NAME.exec(s);
		let next = lt + 1;
		if (m) {
			const tagEnd = gt(SKIPPED_NAME.lastIndex);
			if (tagEnd >= 0) {
				const name = m[1].toLowerCase();
				let closer = closers.get(name);
				if (!closer) {
					closer = forwardRegexEnd(s, new RegExp(`</${name}\\s*>`, 'gi'));
					closers.set(name, closer);
				}
				const end = closer(tagEnd + 1);
				if (end >= 0) {
					out.push(s.slice(kept, lt));
					kept = end;
					next = end;
				}
			}
		}
		lt = s.indexOf('<', next);
	}
	out.push(s.slice(kept));
	return out.join('');
}

/** Replace each `<\/?[^>]+>` — a `<`, at least one char, then the next `>` — with `by`. */
function replaceTags(s: string, by: string): string {
	const out: string[] = [];
	const gt = forwardIndexOf(s, '>');
	let kept = 0;
	let lt = s.indexOf('<');
	while (lt >= 0) {
		const end = gt(lt + 1);
		if (end < 0) break;
		let next = lt + 1;
		if (end >= lt + 2) {
			out.push(s.slice(kept, lt), by);
			kept = end + 1;
			next = end + 1;
		}
		lt = s.indexOf('<', next);
	}
	out.push(s.slice(kept));
	return out.join('');
}

/**
 * `s.indexOf(needle, from)` for non-decreasing `from`, memoized so a run of
 * calls costs one pass over `s` in total.
 */
function forwardIndexOf(s: string, needle: string): (from: number) => number {
	let searchedFrom = -1;
	let found = -1;
	return (from) => {
		if (searchedFrom < 0 || (found >= 0 && found < from)) {
			searchedFrom = from;
			found = s.indexOf(needle, from);
		}
		return found;
	};
}

/**
 * End index of the first match of global `re` at or after `from`, or -1,
 * memoized like forwardIndexOf.
 */
function forwardRegexEnd(s: string, re: RegExp): (from: number) => number {
	let searched = false;
	let start = -1;
	let end = -1;
	return (from) => {
		if (!searched || (start >= 0 && start < from)) {
			searched = true;
			re.lastIndex = from;
			const m = re.exec(s);
			start = m ? m.index : -1;
			end = m ? m.index + m[0].length : -1;
		}
		return end;
	};
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
