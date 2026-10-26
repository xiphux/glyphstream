/**
 * The 'texting' reply style's view of a reply: each top-level markdown block
 * (in practice, each paragraph) is its own text, and a text that opens with
 * `Name: ` is from that person. Display-only — the stored message, and what the
 * model is sent back, is the reply exactly as written, prefixes included, so
 * it can keep track of who said what. `chat/reply-style.ts` is the other half:
 * the instructions telling the model to write this.
 *
 * Splits the RENDERED html, not the markdown source, so a code fence or a list
 * with blank lines in it stays one text — and so the persisted view, which only
 * has the server's cached `content_html`, and the live one split identically.
 */
import type { RenderBlock } from './chat-render';

export type TextingItem =
	| {
			kind: 'text';
			/** Null = the conversation's own assistant. */
			speaker: string | null;
			html: string;
	  }
	| {
			kind: 'text';
			speaker: string | null;
			/** A plain-text text (a live reply before its first markdown render). */
			text: string;
	  }
	/** Everything else in the reply (tool calls, images, reasoning…), rendered
	 *  as it would be in a standard bubble. Consecutive ones are grouped. */
	| { kind: 'blocks'; blocks: RenderBlock[] };

/** The void elements markdown-it and shiki emit: these never get a close tag. */
const VOID = /^(?:br|hr|img)$/i;

/** Matches a start or end tag. markdown-it (html: false) and shiki escape `<` in
 *  text and attribute values, so every `<` that starts a tag name is a tag. */
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g;

/**
 * Split html into its top-level elements. Whitespace between them is dropped;
 * anything else at the top level stays with the element before it.
 */
export function splitTopLevelHtml(html: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let start = 0;
	for (const m of html.matchAll(TAG)) {
		const [whole, closing, rawName, selfClosing] = m;
		const end = m.index + whole.length;
		if (closing) {
			depth = Math.max(0, depth - 1);
			if (depth === 0) {
				pushChunk(out, html.slice(start, end));
				start = end;
			}
		} else if (VOID.test(rawName) || selfClosing) {
			if (depth === 0) {
				pushChunk(out, html.slice(start, end));
				start = end;
			}
		} else {
			depth++;
		}
	}
	// An unclosed tail: a live render mid-stream can't produce one (markdown-it
	// closes what it opens), but losing text silently would be worse than
	// showing it unsplit.
	pushChunk(out, html.slice(start));
	return out;
}

function pushChunk(out: string[], chunk: string): void {
	const trimmed = chunk.trim();
	if (!trimmed) return;
	// A thematic break is a divider, not something anyone texted.
	if (/^<hr\b[^>]*>$/i.test(trimmed)) return;
	out.push(trimmed);
}

/**
 * A speaker name: one to three words of letters, digits and `_ . ' ’ -`, so a
 * username like `xX_chloe_Xx` qualifies and a sentence doesn't. No case rule —
 * chat handles are often lowercase. `&` is excluded because it arrives
 * html-escaped.
 */
const NAME = String.raw`[\p{L}\p{N}_.'’-]+(?: [\p{L}\p{N}_.'’-]+){0,2}`;
const MAX_NAME_CHARS = 30;
/** `Name: `, `**Name:** ` or `**Name**: ` at the very start of a paragraph,
 *  followed by a space — which is what keeps `https://` and `3:30` out. */
const PREFIX = new RegExp(
	String.raw`^<p>(?:(${NAME}): |<strong>(${NAME}):</strong> |<strong>(${NAME})</strong>: )`,
	'u',
);
const PLAIN_PREFIX = new RegExp(String.raw`^(${NAME}): `, 'u');

/** Pull a `Name: ` prefix off a rendered text. Returns the name (or null) and
 *  the html without it. */
export function extractSpeaker(html: string): { speaker: string | null; html: string } {
	const m = PREFIX.exec(html);
	const name = m && (m[1] ?? m[2] ?? m[3]);
	if (!m || !name || name.length > MAX_NAME_CHARS) return { speaker: null, html };
	return { speaker: name, html: '<p>' + html.slice(m[0].length) };
}

function extractPlainSpeaker(text: string): { speaker: string | null; text: string } {
	const m = PLAIN_PREFIX.exec(text);
	if (!m || m[1].length > MAX_NAME_CHARS) return { speaker: null, text };
	return { speaker: m[1], text: text.slice(m[0].length) };
}

/**
 * A reply's blocks as texts. A text without a prefix is from whoever sent the
 * one before it in this reply — the conversation's own assistant for the
 * first. A prefix naming the assistant itself (`defaultName`, compared without
 * case) counts as no prefix, since models often sign their own texts.
 */
export function textingItems(blocks: RenderBlock[], defaultName: string): TextingItem[] {
	const self = defaultName.trim().toLowerCase();
	const items: TextingItem[] = [];
	let speaker: string | null = null;
	const resolve = (named: string | null): string | null => {
		if (named !== null) speaker = named.toLowerCase() === self ? null : named;
		return speaker;
	};

	for (const block of blocks) {
		if (block.type === 'html') {
			for (const chunk of splitTopLevelHtml(block.html)) {
				const { speaker: named, html } = extractSpeaker(chunk);
				items.push({ kind: 'text', speaker: resolve(named), html });
			}
		} else if (block.type === 'plain-text') {
			for (const para of block.text.split(/\n\s*\n/)) {
				const trimmed = para.trim();
				if (!trimmed) continue;
				const { speaker: named, text } = extractPlainSpeaker(trimmed);
				items.push({ kind: 'text', speaker: resolve(named), text });
			}
		} else {
			const last = items.at(-1);
			if (last?.kind === 'blocks') last.blocks.push(block);
			else items.push({ kind: 'blocks', blocks: [block] });
		}
	}
	return items;
}

/** One of a fixed set of hues for a speaker, stable for a given name, so the
 *  same person keeps the same colour across replies and reloads. */
export function speakerHue(name: string): number {
	let h = 0;
	for (const ch of name.toLowerCase()) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
	return SPEAKER_HUES[h % SPEAKER_HUES.length];
}

const SPEAKER_HUES = [12, 38, 95, 150, 190, 220, 265, 300, 335];
