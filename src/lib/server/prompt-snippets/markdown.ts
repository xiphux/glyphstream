/**
 * The prompt-snippet library file format: one Markdown document, snippets
 * split on `##` headings, with optional `key: value` metadata lines before the
 * body.
 *
 *     ## Akira Toriyama Style
 *     kinds: image, video
 *     tags: anime, character
 *
 *     clean and highly readable linework, appealing character-focused
 *     design language...
 *
 * Markdown rather than JSON because this file is meant to be *hand-authored*:
 * a style fragment is a multi-paragraph prose blob, which JSON would force
 * through `\n` escaping and quote-doubling, and one stray comma would
 * invalidate a 100-entry library. It also matches how the rest of the project
 * stores authored content (skills are SKILL.md bundles).
 *
 * Pure + framework-free: no DB, no SvelteKit. `parseSnippetMarkdown` and
 * `serializeSnippetMarkdown` are exact inverses, so export → import is
 * lossless and a user can round-trip their library through a text editor.
 *
 * Losslessness is not free: a body may legitimately contain lines that look
 * like this format's own syntax — a prompt template with `## Section`
 * headings, or a Booru-style fragment whose first line is `tags: 8k,
 * photorealistic`. Those are escaped with a leading backslash on the way out
 * and unescaped on the way back in (see ESCAPABLE), so they survive the
 * round-trip instead of re-parsing as structure and silently splitting or
 * truncating the snippet.
 */

import { isSnippetKind, type PromptSnippet, type SnippetKind } from '$lib/types/api';

export interface ParsedSnippet {
	name: string;
	body: string;
	kinds: SnippetKind[];
	tags: string[];
}

export interface ParsedSnippetFile {
	snippets: ParsedSnippet[];
	/** Entries that could not be imported, with the reason. */
	skipped: string[];
	/** Non-fatal oddities (unknown metadata keys, unknown kinds). */
	warnings: string[];
}

/**
 * The characters this format treats as ending a line.
 *
 * This is ECMAScript's LineTerminator set — LF, CR, LS (U+2028), PS (U+2029) —
 * which is *exactly* the set a JS regex `.` refuses to match. That equivalence
 * is the whole reason this constant exists rather than being inlined: `HEADING`
 * and `META` both use `.`, so any of these characters left sitting INSIDE a
 * line makes that line match neither pattern, and it gets silently absorbed
 * into the previous snippet's body — losing a snippet and corrupting its
 * neighbour, with nothing reported.
 *
 * Splitting on the same set the patterns assume keeps the line model and the
 * patterns in agreement. Single-line fields (a snippet's name, its tags) reject
 * these characters for the same reason — see `validate.ts`, which imports this.
 *
 * Note `\r\n` is listed first in LINE_SPLIT so a CRLF pair counts as one break
 * rather than two.
 */
export const LINE_BREAKS = /[\r\n\u2028\u2029]/;
const LINE_SPLIT = /\r\n|[\r\n\u2028\u2029]/;
const LINE_SPLIT_ALL = /\r\n|[\r\n\u2028\u2029]/g;

/**
 * Collapse every line terminator to LF.
 *
 * Multi-line fields (a body) can't reject these the way single-line fields do
 * — a break there is meaningful — so they're normalized instead, which is the
 * contract CRLF has always had here. Storing only LF keeps what's in the
 * database identical to what round-trips through the format.
 *
 * Must go through LINE_SPLIT_ALL rather than a hand-written character class:
 * `\r\n` has to be listed FIRST or a CRLF pair becomes two newlines.
 */
export function normalizeLineBreaks(text: string): string {
	return text.replace(LINE_SPLIT_ALL, '\n');
}

const HEADING = /^##\s+(.+?)\s*$/;

// Only these exact keys are metadata. Matching a generic `key: value` shape
// instead would be a trap: a style body legitimately opens with lines like
// "Style: a clean, expressive look", and eating that as metadata would leave
// the snippet bodyless. An unrecognized `word:` line is body, always.
const META = /^(kinds|tags)\s*:\s*(.*)$/i;

/**
 * A body line that gets an escape backslash on the way out, OR one already
 * carrying escape backslashes in front of such a pattern.
 *
 * Deliberately WIDER than the parser's own `HEADING`, which recognizes only
 * `##`: this escapes every Markdown heading level, `#` through `######`. Levels
 * other than `##` are not a round-trip hazard — the parser would never read
 * them as structure — but an exported library is a Markdown file people open in
 * editors and viewers, where an unescaped `# Title` inside a body renders as a
 * document heading. Escaping the whole family keeps the export readable as
 * Markdown at no correctness cost, since unescape reverses it exactly.
 *
 * Including the leading `\\*` is what makes the escape round-trip at any
 * depth: a body line that literally reads `\## Section` becomes `\\## Section`
 * on the way out and unescapes back to exactly one backslash, rather than
 * being mistaken for an already-escaped heading and losing a character.
 */
const ESCAPABLE = /^\\*(?:#{1,6}\s|(?:kinds|tags)\s*:)/i;

/** Escape a body line on the way out, if it would otherwise re-parse as
 *  structure. Inverse of `unescapeBodyLine`. */
function escapeBodyLine(line: string): string {
	return ESCAPABLE.test(line) ? `\\${line}` : line;
}

/** Strip exactly one escape backslash from a body line that carries one.
 *  Inverse of `escapeBodyLine`. */
function unescapeBodyLine(line: string): string {
	return line.startsWith('\\') && ESCAPABLE.test(line.slice(1)) ? line.slice(1) : line;
}

function splitList(value: string): string[] {
	return value
		.split(',')
		.map((v) => v.trim())
		.filter((v) => v.length > 0);
}

/**
 * Parse a snippet library file.
 *
 * Forgiving by design — a malformed entry is reported and skipped rather than
 * failing the whole import, because the realistic input is a ~100-entry file a
 * human hand-converted, and losing 99 good snippets to one bad heading would
 * be a terrible trade.
 */
export function parseSnippetMarkdown(content: string): ParsedSnippetFile {
	const lines = content.split(LINE_SPLIT);
	const snippets: ParsedSnippet[] = [];
	const skipped: string[] = [];
	const warnings: string[] = [];

	// Content before the first heading is ignored, so a library file can carry
	// a title and explanatory preamble.
	let current: {
		name: string;
		meta: string[][];
		body: string[];
		metaOpen: boolean;
		/** Set when a blank line closed the metadata window — arm a check on the
		 *  first real body line for the shape that turns metadata into body text. */
		checkStrayMeta: boolean;
	} | null = null;

	const flush = () => {
		if (!current) return;
		const { name, meta, body } = current;
		current = null;

		// A heading whose text is only whitespace can't name anything, and the
		// create/edit API would reject it — so import must too, rather than
		// persisting a row that renders blank and can't be found by search.
		if (!name) {
			skipped.push('(unnamed): heading has no name');
			return;
		}

		const kinds: SnippetKind[] = [];
		const tags: string[] = [];
		for (const [key, value] of meta) {
			const k = key.toLowerCase();
			if (k === 'kinds') {
				for (const entry of splitList(value)) {
					if (isSnippetKind(entry)) kinds.push(entry);
					else warnings.push(`${name}: unknown kind "${entry}" ignored`);
				}
			} else if (k === 'tags') {
				tags.push(...splitList(value));
			}
		}

		const text = body.join('\n').trim();
		if (!text) {
			skipped.push(`${name}: no body`);
			return;
		}
		snippets.push({ name, body: text, kinds: [...new Set(kinds)], tags: [...new Set(tags)] });
	};

	for (const line of lines) {
		const heading = HEADING.exec(line);
		if (heading) {
			flush();
			// Trim the captured heading: `HEADING`'s `(.+?)` can capture pure
			// whitespace (e.g. `##<tab><space>`), which would otherwise persist a
			// blank-named row that the create/edit API rejects.
			current = {
				name: heading[1].trim(),
				meta: [],
				body: [],
				metaOpen: true,
				checkStrayMeta: false,
			};
			continue;
		}
		if (!current) continue;

		// Metadata is only recognized in the contiguous run of `kinds:`/`tags:`
		// lines directly under the heading — see the META comment for why the
		// key set is closed rather than generic.
		//
		// `metaOpen` is tracked explicitly rather than inferred from
		// `body.length === 0`: with that inference a snippet carrying NO
		// metadata never closed its window at the blank line (nothing was
		// pushed to the body, so the length stayed 0), and a `tags:` line
		// arbitrarily far down the body was still swallowed as metadata —
		// silently truncating the body and inventing tags. Worse, it only
		// happened for snippets *without* metadata, so the same body parsed
		// two different ways depending on its neighbours.
		if (current.metaOpen) {
			if (line.trim() === '') {
				// A blank line always ends the metadata block, whether or not any
				// metadata was seen. Keep it out of the body's first position.
				current.metaOpen = false;
				if (current.meta.length > 0) current.body.push('');
				// Arm the stray-metadata check unconditionally. It used to be armed
				// only when NO metadata preceded the blank line, on the theory that
				// an author who already wrote `kinds:` knows the convention — but
				// writing one metadata line and then hitting Enter twice is exactly
				// how this happens, and the narrow arming meant an identical body
				// was diagnosed in one snippet and silently swallowed in the next.
				current.checkStrayMeta = true;
				continue;
			}
			const meta = META.exec(line);
			if (meta) {
				current.meta.push([meta[1], meta[2]]);
				continue;
			}
			// A non-blank, non-metadata line: the body starts here.
			current.metaOpen = false;
		}

		// The spec is unambiguous — metadata must sit directly under the heading
		// — but a blank line there is such a natural thing to type that failing
		// silently is the real defect. Warn instead of guessing: reading it as
		// metadata would destroy a legitimate body whose first line happens to
		// be a tag list, which is a worse failure than a noisy one.
		//
		// Tested against the RAW line, so an explicitly escaped `\tags:` (the
		// author saying "this really is body") never warns.
		if (current.checkStrayMeta && line.trim() !== '') {
			current.checkStrayMeta = false;
			if (META.test(line)) {
				warnings.push(
					`${current.name}: "${line.trim()}" was read as body text — metadata must follow the heading with no blank line between. Prefix it with \\ to silence this.`,
				);
			}
		}
		current.body.push(unescapeBodyLine(line));
	}
	flush();

	return { snippets, skipped, warnings };
}

/**
 * Render snippets back to the library format. Exact inverse of the parser.
 *
 * Body lines that would re-parse as a heading or a metadata key are escaped
 * (see ESCAPABLE) so the round-trip holds for prompt templates that contain
 * their own `##` sections or open with a `tags:` line.
 */
export function serializeSnippetMarkdown(snippets: PromptSnippet[]): string {
	const blocks = snippets.map((s) => {
		const lines = [`## ${s.name}`];
		if (s.kinds.length > 0) lines.push(`kinds: ${s.kinds.join(', ')}`);
		if (s.tags.length > 0) lines.push(`tags: ${s.tags.join(', ')}`);
		// Split on LINE_SPLIT, not '\n'. The parser splits on the full terminator
		// set, so splitting on LF alone here left any segment after a lone CR /
		// U+2028 / U+2029 unseen by escapeBodyLine — a `## …` there went out
		// unescaped and re-parsed as a heading, truncating this body and
		// fabricating a snippet from its tail, silently. The two halves of the
		// round-trip have to agree on what a line is.
		lines.push('', ...s.body.split(LINE_SPLIT).map(escapeBodyLine));
		return lines.join('\n');
	});
	return blocks.join('\n\n') + '\n';
}
