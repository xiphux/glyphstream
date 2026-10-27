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
 *
 * A text that is nothing but `[photo: description]` is a photo the sender took:
 * it shows as a placeholder until the user develops it into an image, which
 * then arrives as its own message after the reply (see `texting-photos.ts`).
 */
import type { RenderBlock } from './chat-render';
import type { PhotoOrigin } from './types/api';

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
	/** A `[photo: …]` marker. `index` is its position among the reply's photos,
	 *  which is what a developed photo's `PhotoOrigin.index` points back at. */
	| { kind: 'photo'; speaker: string | null; description: string; index: number }
	/** A developed photo: an image carrying a `PhotoOrigin`, from its sender. */
	| {
			kind: 'sent-photo';
			speaker: string | null;
			block: Extract<RenderBlock, { type: 'image' }> & { photo: PhotoOrigin };
	  }
	/** Everything else in the reply (tool calls, images, reasoning…), rendered
	 *  as it would be in a standard bubble. Consecutive ones are grouped. */
	| { kind: 'blocks'; blocks: RenderBlock[] };

/** What this row's photos can do. Absent for a live reply, whose markers
 *  can't be developed until it has finished. */
export interface TextingPhotos {
	/** Which of this reply's markers have arrived as photos (by index). */
	developed: ReadonlySet<number>;
	/** Develop a marker. Present only while this reply's photos can be
	 *  developed — it's the latest thing in the thread and nothing is running. */
	onDevelop?: (index: number) => void;
	/** Develop this row's photo again. Present only on the latest photo,
	 *  under the same conditions. */
	onRedevelop?: () => void;
	/** The marker being developed right now, which says so instead of offering
	 *  the button. */
	developing?: number | null;
}

/** The void elements markdown-it and shiki emit: these never get a close tag. */
const VOID = /^(?:br|hr|img)$/i;

/** Matches a start or end tag. markdown-it (html: false) and shiki escape `<` in
 *  text and attribute values, so every `<` that starts a tag name is a tag. */
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g;

/**
 * Split html into its top-level elements. Whitespace between them is dropped;
 * any other stray top-level text is kept, joined to the element that follows
 * it (or as a chunk of its own at the very end).
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
 * A rendered text that is only a photo marker: `[photo: …]`, case-insensitive,
 * optionally italic or bold (models like to set actions in asterisks). The
 * description keeps any inline markup it had, which `htmlToText` then drops.
 *
 * The description stops at the first `]`, so two markers run into one
 * paragraph (no blank line between) stay a text rather than becoming one photo
 * described as `a]\n[photo: b`.
 */
const PHOTO_HTML = /^<p>(?:<(?:em|strong)>)?\[photo:\s*([^\]]+?)\s*\](?:<\/(?:em|strong)>)?<\/p>$/i;
const PHOTO_TEXT = /^([*_]{0,2})\[photo:\s*([^\]]+?)\s*\]\1$/i;

/** The text of a markdown-it html fragment: tags dropped, the entities its
 *  `escapeHtml` emits decoded. */
function htmlToText(html: string): string {
	return html
		.replace(/<[^>]*>/g, '')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, '&')
		.trim();
}

/** The description of a photo marker, or null when the text isn't one. */
export function photoDescription(text: { html: string } | { text: string }): string | null {
	if ('html' in text) {
		const m = PHOTO_HTML.exec(text.html.trim());
		return m ? htmlToText(m[1]) || null : null;
	}
	const m = PHOTO_TEXT.exec(text.text.trim());
	return m ? m[2].trim() || null : null;
}

/**
 * A reply's blocks as texts. A text without a prefix is from whoever sent the
 * one before it in this reply — the conversation's own assistant for the
 * first. A prefix naming the assistant itself (`defaultName`, compared without
 * case) hands the text back to the assistant, since models often sign their
 * own texts.
 */
export function textingItems(blocks: RenderBlock[], defaultName: string): TextingItem[] {
	const self = defaultName.trim().toLowerCase();
	const items: TextingItem[] = [];
	let speaker: string | null = null;
	// A marker's number is PERSISTED: a developed photo's `PhotoOrigin.index`
	// names the marker it came from. Changing what counts as a marker (or the
	// order they're counted in) renumbers every stored reply, and the wrong
	// placeholders then show as developed.
	let photos = 0;
	const resolve = (named: string | null): string | null => {
		if (named !== null) speaker = named.toLowerCase() === self ? null : named;
		return speaker;
	};
	const push = (from: string | null, text: { html: string } | { text: string }) => {
		const description = photoDescription(text);
		if (description === null) items.push({ kind: 'text', speaker: from, ...text });
		else items.push({ kind: 'photo', speaker: from, description, index: photos++ });
	};

	for (const block of blocks) {
		if (block.type === 'html') {
			for (const chunk of splitTopLevelHtml(block.html)) {
				const { speaker: named, html } = extractSpeaker(chunk);
				push(resolve(named), { html });
			}
		} else if (block.type === 'plain-text') {
			for (const para of block.text.split(/\n\s*\n/)) {
				const trimmed = para.trim();
				if (!trimmed) continue;
				const { speaker: named, text } = extractPlainSpeaker(trimmed);
				push(resolve(named), { text });
			}
		} else if (block.type === 'image' && block.photo) {
			// From whoever the marker named, which the photo carries with it: it
			// arrives in a row of its own, after texts that may have changed sender.
			const from = block.photo.speaker ?? null;
			items.push({ kind: 'sent-photo', speaker: from, block: { ...block, photo: block.photo } });
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
