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
 * it shows as a placeholder until the user develops it into an image, which is
 * then kept on the reply and shows in the placeholder's place (see
 * `message_images`).
 *
 * A text that is nothing but `[later 1h: …]` sets a check-in (see
 * `check-ins.ts`). It isn't a text anyone sent, so it never shows as one.
 */
import { checkInMarker, type CheckInMarker } from './check-ins';
import type { RenderBlock } from './chat-render';
import type { MessageImage } from './types/api';

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
	 *  which is what its developed versions are stored against. */
	| { kind: 'photo'; speaker: string | null; description: string; index: number }
	/** A `[later …]` check-in marker, shown (if at all) as a note, not a text. */
	| ({ kind: 'later' } & CheckInMarker)
	/** Everything else in the reply (tool calls, images, reasoning…), rendered
	 *  as it would be in a standard bubble. Consecutive ones are grouped. */
	| { kind: 'blocks'; blocks: RenderBlock[] };

/** This reply's photos, and what can be done with them. Absent for a live
 *  reply, whose markers can't be developed until it has finished. */
export interface TextingPhotos {
	/** Every version of each developed photo, by marker index, oldest first —
	 *  and a failed attempt, until the next one lands. */
	versions: ReadonlyMap<number, readonly MessageImage[]>;
	/** The markers a draw is under way for. */
	developing: ReadonlySet<number>;
	/** Open the develop dialog for a marker: first time, again, or after a
	 *  failure. Absent where nothing can draw. */
	onDevelop?: (index: number) => void;
	/** Put a version on show (the arrows). */
	onShow?: (image: MessageImage) => void;
	/** Move a version's image to the trash. */
	onRemove?: (image: MessageImage) => void;
}

/** The void elements markdown-it and shiki emit: these never get a close tag. */
const VOID = /^(?:br|hr|img)$/i;

/** Matches a start or end tag. markdown-it (html: false) and shiki escape `<` in
 *  text and attribute values, so every `<` that starts a tag name is a tag. */
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g;

/**
 * Split html into its top-level elements. Whitespace between them is dropped;
 * any other stray top-level text is kept, joined to the element that follows
 * it (or as a chunk of its own at the very end). A thematic break (`<hr>`) is
 * dropped — a divider isn't something anyone texted — unless `keepBreaks`, for
 * a standard reply being cut around its photos.
 */
export function splitTopLevelHtml(html: string, keepBreaks = false): string[] {
	const out: string[] = [];
	let depth = 0;
	let start = 0;
	for (const m of html.matchAll(TAG)) {
		const [whole, closing, rawName, selfClosing] = m;
		const end = m.index + whole.length;
		if (closing) {
			depth = Math.max(0, depth - 1);
			if (depth === 0) {
				pushChunk(out, html.slice(start, end), keepBreaks);
				start = end;
			}
		} else if (VOID.test(rawName) || selfClosing) {
			if (depth === 0) {
				pushChunk(out, html.slice(start, end), keepBreaks);
				start = end;
			}
		} else {
			depth++;
		}
	}
	// An unclosed tail: a live render mid-stream can't produce one (markdown-it
	// closes what it opens), but losing text silently would be worse than
	// showing it unsplit.
	pushChunk(out, html.slice(start), keepBreaks);
	return out;
}

function pushChunk(out: string[], chunk: string, keepBreaks: boolean): void {
	const trimmed = chunk.trim();
	if (!trimmed) return;
	// A thematic break is a divider, not something anyone texted.
	if (!keepBreaks && /^<hr\b[^>]*>$/i.test(trimmed)) return;
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

export function extractPlainSpeaker(text: string): { speaker: string | null; text: string } {
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
	// A marker's number is PERSISTED: a developed photo's versions are stored
	// against it (`message_images.marker_index`). Changing what counts as a
	// marker (or the order they're counted in) renumbers every stored reply,
	// and the wrong photos then show in the wrong places. A standard reply
	// numbers its photos too (`splitAtPhotos` in texting-photos.ts), and must
	// count exactly as this does.
	let photos = 0;
	const resolve = (named: string | null): string | null => {
		if (named !== null) speaker = named.toLowerCase() === self ? null : named;
		return speaker;
	};
	const push = (from: string | null, text: { html: string } | { text: string }) => {
		const later = checkInMarker(text);
		if (later) {
			items.push({ kind: 'later', ...later });
			return;
		}
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
		} else if (block.type === 'plain-text' && block.ownReaction) {
			// The model's own reaction: from it, not whoever spoke last.
			speaker = null;
			push(null, { text: block.text });
		} else if (block.type === 'plain-text') {
			for (const para of block.text.split(/\n\s*\n/)) {
				const trimmed = para.trim();
				if (!trimmed) continue;
				const { speaker: named, text } = extractPlainSpeaker(trimmed);
				push(resolve(named), { text });
			}
		} else {
			const last = items.at(-1);
			if (last?.kind === 'blocks') last.blocks.push(block);
			else items.push({ kind: 'blocks', blocks: [block] });
		}
	}
	return items;
}

/**
 * A reply's blocks without its `[later …]` texts — for the standard reply
 * style, whose bubble would otherwise show the marker as a paragraph. (The
 * texting bubbles split into texts anyway, and drop them there.)
 */
export function withoutCheckInMarkers(blocks: RenderBlock[]): RenderBlock[] {
	if (!blocks.some(mayHoldMarker)) return blocks;
	return blocks.flatMap((block): RenderBlock[] => {
		if (!mayHoldMarker(block)) return [block];
		if (block.type === 'html') {
			// Dividers kept: in a standard reply they're part of what was written.
			const kept = splitTopLevelHtml(block.html, true).filter(
				(chunk) => !checkInMarker(extractSpeaker(chunk)),
			);
			return kept.length ? [{ ...block, html: kept.join('\n') }] : [];
		}
		if (block.type === 'plain-text') {
			const kept = block.text
				.split(/\n\s*\n/)
				.filter((para) => !checkInMarker(extractPlainSpeaker(para.trim())));
			return kept.join('').trim() ? [{ ...block, text: kept.join('\n\n') }] : [];
		}
		return [block];
	});
}

function mayHoldMarker(block: RenderBlock): boolean {
	return (
		(block.type === 'html' && /\[later\s/i.test(block.html)) ||
		(block.type === 'plain-text' && /\[later\s/i.test(block.text))
	);
}

/** One of a fixed set of hues for a speaker, stable for a given name, so the
 *  same person keeps the same colour across replies and reloads. */
export function speakerHue(name: string): number {
	let h = 0;
	for (const ch of name.toLowerCase()) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
	return SPEAKER_HUES[h % SPEAKER_HUES.length];
}

const SPEAKER_HUES = [12, 38, 95, 150, 190, 220, 265, 300, 335];
