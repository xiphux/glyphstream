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

const HEADING = /^##\s+(.+?)\s*$/;

// Only these exact keys are metadata. Matching a generic `key: value` shape
// instead would be a trap: a style body legitimately opens with lines like
// "Style: a clean, expressive look", and eating that as metadata would leave
// the snippet bodyless. An unrecognized `word:` line is body, always.
const META = /^(kinds|tags)\s*:\s*(.*)$/i;

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
	const lines = content.split(/\r?\n/);
	const snippets: ParsedSnippet[] = [];
	const skipped: string[] = [];
	const warnings: string[] = [];

	// Content before the first heading is ignored, so a library file can carry
	// a title and explanatory preamble.
	let current: { name: string; meta: string[][]; body: string[] } | null = null;

	const flush = () => {
		if (!current) return;
		const { name, meta, body } = current;
		current = null;

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
			current = { name: heading[1], meta: [], body: [] };
			continue;
		}
		if (!current) continue;

		// Metadata is only recognized in the contiguous run of `kinds:`/`tags:`
		// lines directly under the heading — see the META comment for why the
		// key set is closed rather than generic.
		if (current.body.length === 0) {
			if (line.trim() === '') {
				// Blank line ends the metadata block; don't start the body with it.
				if (current.meta.length > 0) {
					current.body.push('');
					continue;
				}
				continue;
			}
			const meta = META.exec(line);
			if (meta) {
				current.meta.push([meta[1], meta[2]]);
				continue;
			}
		}
		current.body.push(line);
	}
	flush();

	return { snippets, skipped, warnings };
}

/** Render snippets back to the library format. Exact inverse of the parser. */
export function serializeSnippetMarkdown(snippets: PromptSnippet[]): string {
	const blocks = snippets.map((s) => {
		const lines = [`## ${s.name}`];
		if (s.kinds.length > 0) lines.push(`kinds: ${s.kinds.join(', ')}`);
		if (s.tags.length > 0) lines.push(`tags: ${s.tags.join(', ')}`);
		lines.push('', s.body);
		return lines.join('\n');
	});
	return blocks.join('\n\n') + '\n';
}
