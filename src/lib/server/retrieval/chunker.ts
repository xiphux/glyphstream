/**
 * Structure-aware chunking for relevance selection.
 *
 * The win over fixed-size slicing is twofold:
 *   1. Chunks split on the document's own block boundaries (paragraphs, list
 *      items, headings) so a chunk rarely cuts a sentence — and never
 *      straddles two sections.
 *   2. Every chunk is prefixed with a breadcrumb (page title › heading path)
 *      so a retrieved mid-document chunk still carries "where am I" context.
 *      This is the cheap, LLM-free form of contextual retrieval and is the
 *      single highest-leverage quality lever in the pipeline.
 *
 * `chunkArticleHtml` walks the Readability article HTML (which preserves
 * heading structure that the flattened `textContent` discards).
 * `chunkPlainText` is the fallback for non-HTML or unparseable content.
 */

import { parseHTML } from 'linkedom';

export interface Chunk {
	/** Breadcrumb + body — the unit that gets scored, embedded, and emitted. */
	text: string;
	/** Body without the breadcrumb prefix — used for the document-order join. */
	body: string;
	/** "Page Title › H2 › H3" (empty when there's no title or heading path). */
	breadcrumb: string;
	/** 0-based document order. Consecutive indices are adjacent in the source. */
	blockIndex: number;
	/**
	 * Length of the leading `body` substring that is overlap duplicated from
	 * the previous (blockIndex-1) chunk. The join in `select.ts` strips this
	 * when both neighbors are selected, so overlap aids recall without
	 * duplicating text in the final output. 0 when there's no overlap.
	 */
	overlapPrefixLen: number;
}

export interface ChunkOptions {
	targetChars?: number;
	overlapChars?: number;
	maxChars?: number;
}

export const CHUNK_TARGET_CHARS = 1800; // ~450 tokens @ ~4 chars/token
export const CHUNK_OVERLAP_CHARS = 200; // ~50 tokens
export const CHUNK_MAX_CHARS = 3200; // hard ceiling before a single block is split

interface ResolvedOptions {
	targetChars: number;
	overlapChars: number;
	maxChars: number;
}

interface Unit {
	breadcrumb: string;
	text: string;
}

const HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
const ATOMIC_TAGS = new Set(['P', 'LI', 'BLOCKQUOTE', 'PRE', 'FIGCAPTION', 'DD', 'DT']);
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'IFRAME', 'TEMPLATE', 'HEAD']);

function resolveOptions(opts?: ChunkOptions): ResolvedOptions {
	return {
		targetChars: opts?.targetChars ?? CHUNK_TARGET_CHARS,
		overlapChars: opts?.overlapChars ?? CHUNK_OVERLAP_CHARS,
		maxChars: opts?.maxChars ?? CHUNK_MAX_CHARS,
	};
}

function normalizeWhitespace(s: string): string {
	return s
		.replace(/[ \t]+/g, ' ')
		.replace(/ ?\n ?/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

// ---------------------------------------------------------------------------
// HTML path
// ---------------------------------------------------------------------------

export function chunkArticleHtml(contentHtml: string, title: string, opts?: ChunkOptions): Chunk[] {
	const o = resolveOptions(opts);
	const cleanTitle = (title ?? '').trim();
	let units: Unit[] = [];
	let rootText = '';

	try {
		const { document } = parseHTML(`<!DOCTYPE html><html><body>${contentHtml}</body></html>`);
		const root = document.body ?? document;
		rootText = normalizeWhitespace(root.textContent ?? '');
		collectUnits(root, [], cleanTitle, units);
	} catch {
		// Malformed fragment — fall through to the plain-text path below.
	}

	if (units.length === 0) {
		// Content had text but no recognizable block structure (or parse
		// failed). Coarser, but still beats blind head-truncation.
		return chunkPlainText(rootText || stripTags(contentHtml), cleanTitle, opts);
	}

	units = expandOversized(units, o.maxChars);
	return packUnits(units, o);
}

interface HeadingFrame {
	level: number;
	text: string;
}

function buildBreadcrumb(title: string, stack: HeadingFrame[]): string {
	const parts: string[] = [];
	if (title) parts.push(title);
	for (const h of stack) parts.push(h.text);
	return parts.join(' › ');
}

/** Depth-first walk in document order, maintaining the heading hierarchy. */
function collectUnits(node: Element, stack: HeadingFrame[], title: string, out: Unit[]): void {
	for (const child of Array.from(node.childNodes)) {
		if (child.nodeType !== 1) continue; // element nodes only
		const el = child as Element;
		const tag = el.tagName;
		if (SKIP_TAGS.has(tag)) continue;

		if (HEADING_TAGS.has(tag)) {
			const level = Number(tag[1]);
			const text = normalizeWhitespace(el.textContent ?? '');
			while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
			if (text) stack.push({ level, text });
			continue;
		}

		if (tag === 'TR') {
			const cells = Array.from(el.children)
				.filter((c) => c.tagName === 'TD' || c.tagName === 'TH')
				.map((c) => normalizeWhitespace(c.textContent ?? ''))
				.filter(Boolean);
			const text = cells.join('\t');
			if (text) out.push({ breadcrumb: buildBreadcrumb(title, stack), text });
			continue;
		}

		if (ATOMIC_TAGS.has(tag)) {
			const text = normalizeWhitespace(el.textContent ?? '');
			if (text) out.push({ breadcrumb: buildBreadcrumb(title, stack), text });
			continue;
		}

		// Container element — descend (carries the heading stack forward).
		collectUnits(el, stack, title, out);
	}
}

function stripTags(html: string): string {
	return normalizeWhitespace(
		html
			.replace(/<[^>]+>/g, ' ')
			.replace(/&nbsp;/g, ' ')
			.replace(/&amp;/g, '&')
			.replace(/&lt;/g, '<')
			.replace(/&gt;/g, '>'),
	);
}

// ---------------------------------------------------------------------------
// Plain-text path (fallback; markdown/plain/JSON)
// ---------------------------------------------------------------------------

export function chunkPlainText(text: string, title: string, opts?: ChunkOptions): Chunk[] {
	const o = resolveOptions(opts);
	const cleanTitle = (title ?? '').trim();
	const trimmed = (text ?? '').trim();
	if (!trimmed) return [];

	let parts = trimmed
		.split(/\n{2,}/)
		.map((s) => s.trim())
		.filter(Boolean);
	if (parts.length <= 1) {
		parts = trimmed
			.split(/\n/)
			.map((s) => s.trim())
			.filter(Boolean);
	}
	if (parts.length === 0) parts = [trimmed];

	const units: Unit[] = parts.map((p) => ({ breadcrumb: cleanTitle, text: p }));
	return packUnits(expandOversized(units, o.maxChars), o);
}

// ---------------------------------------------------------------------------
// Shared: oversize splitting + packing with in-section overlap
// ---------------------------------------------------------------------------

/** Split any unit longer than maxChars into word-boundary pieces. */
function expandOversized(units: Unit[], maxChars: number): Unit[] {
	const out: Unit[] = [];
	for (const u of units) {
		if (u.text.length <= maxChars) {
			out.push(u);
			continue;
		}
		for (const piece of hardSplit(u.text, maxChars)) {
			out.push({ breadcrumb: u.breadcrumb, text: piece });
		}
	}
	return out;
}

function hardSplit(text: string, maxChars: number): string[] {
	const pieces: string[] = [];
	let i = 0;
	while (i < text.length) {
		if (text.length - i <= maxChars) {
			pieces.push(text.slice(i).trim());
			break;
		}
		let end = i + maxChars;
		const ws = text.lastIndexOf(' ', end);
		if (ws > i + maxChars / 2) end = ws; // only honor a boundary that isn't absurdly early
		pieces.push(text.slice(i, end).trim());
		i = end;
	}
	return pieces.filter((p) => p.length > 0);
}

/** Trailing slice of `s` up to maxChars, advanced to start at a word boundary. */
function tailWords(s: string, maxChars: number): string {
	if (maxChars <= 0 || s.length <= maxChars) return '';
	const start = s.length - maxChars;
	const ws = s.indexOf(' ', start);
	const from = ws >= 0 && ws < s.length - 1 ? ws + 1 : start;
	return s.slice(from).trim();
}

/**
 * Pack ordered units into chunks: accumulate same-breadcrumb units up to
 * targetChars, flush on overflow or a breadcrumb change. On a mid-section
 * flush, seed the next chunk with an overlap tail of the one just flushed
 * (recorded as overlapPrefixLen so the join can dedupe it). No overlap is
 * carried across a section boundary.
 */
function packUnits(units: Unit[], o: ResolvedOptions): Chunk[] {
	const chunks: Chunk[] = [];
	let buf = '';
	let breadcrumb: string | null = null;
	let overlapLen = 0;

	const flush = () => {
		const body = buf.trim();
		if (body.length === 0) {
			buf = '';
			overlapLen = 0;
			return;
		}
		const bc = breadcrumb ?? '';
		const text = bc ? `${bc}\n\n${body}` : body;
		chunks.push({
			text,
			body,
			breadcrumb: bc,
			blockIndex: chunks.length,
			overlapPrefixLen: Math.min(overlapLen, body.length),
		});
	};

	for (const u of units) {
		if (breadcrumb === null) breadcrumb = u.breadcrumb;

		if (u.breadcrumb !== breadcrumb) {
			flush();
			buf = '';
			overlapLen = 0;
			breadcrumb = u.breadcrumb;
		}

		const sep = buf ? '\n\n' : '';
		if (buf && buf.length + sep.length + u.text.length > o.targetChars) {
			const prev = buf;
			flush();
			const seed = tailWords(prev, o.overlapChars);
			if (seed) {
				buf = `${seed}\n\n${u.text}`;
				overlapLen = seed.length + 2; // include the "\n\n" separator
			} else {
				buf = u.text;
				overlapLen = 0;
			}
		} else {
			buf = buf ? `${buf}${sep}${u.text}` : u.text;
		}
	}
	flush();
	return chunks;
}
