/**
 * A `Name: ` prefix on a paragraph, which models write to say who's talking —
 * in a group chat, or signing their own line. Its own module because both
 * `texting.ts` (the bubbles) and `scenes.ts` (where a scene changes) read
 * through it, and they must agree on what a prefixed paragraph says.
 */

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
