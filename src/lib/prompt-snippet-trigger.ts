/**
 * Caret-aware trigger parsing for the prompt-snippet autocomplete. Pure +
 * framework-free so it can be unit-tested in isolation and shared by all three
 * composers (chat page, new-chat home, inline message editor).
 *
 * Deliberately NOT built on `skill-command.ts`, despite the surface
 * similarity. A skill command is anchored to the *whole draft* (`^/token$`),
 * so it needs no caret and replaces the entire textarea. A snippet fires
 * mid-message — you type a description, then pull a style into the middle of
 * it — so every function here works from a caret offset and reports the range
 * to replace.
 *
 * `;` is the trigger: the classic text-expander prefix (TextExpander, aText,
 * Alfred). `/` was taken by skills, and `@` is too strongly established
 * elsewhere as "pull in another model/agent" (ChatGPT GPT-mentions, Copilot
 * participants) to reuse without misleading users.
 */

import type { PromptSnippet, SnippetKind } from '$lib/types/api';

export const SNIPPET_TRIGGER = ';';

export interface SnippetQuery {
	/** Text typed after the trigger. `''` (a bare `;`) means "show all". */
	query: string;
	/** Index of the trigger char — the start of the range to replace. */
	start: number;
}

function isWhitespace(ch: string): boolean {
	return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

/**
 * The in-progress autocomplete query at `caret`, or null when the menu should
 * be closed.
 *
 * Scans backwards from the caret for the trigger, stopping at the first
 * whitespace — a query never spans a space, which both bounds the scan to one
 * word and closes the menu naturally once the user types past the name.
 *
 * The **start-of-word rule** (the trigger must sit at index 0 or directly
 * after whitespace) is what makes `;` safe to type normally: `const x = 1;`
 * and `foo; bar` put the `;` after a word character or before a space, so
 * neither opens the menu. It also keeps the snippet and skill menus mutually
 * exclusive — in `/;x` the `;` follows `/`, so this returns null.
 */
export function snippetMenuQuery(text: string, caret: number): SnippetQuery | null {
	if (caret < 0 || caret > text.length) return null;
	for (let i = caret - 1; i >= 0; i--) {
		const ch = text[i];
		if (isWhitespace(ch)) return null;
		if (ch !== SNIPPET_TRIGGER) continue;
		// Start-of-word rule.
		if (i > 0 && !isWhitespace(text[i - 1])) return null;
		return { query: text.slice(i + 1, caret), start: i };
	}
	return null;
}

/** True when a snippet applies to the active modality. A snippet with no
 *  kinds is generic and applies everywhere; a null kind (no model resolved
 *  yet) doesn't filter anything out. */
function matchesKind(snippet: PromptSnippet, activeKind: SnippetKind | null): boolean {
	if (activeKind === null || snippet.kinds.length === 0) return true;
	return snippet.kinds.includes(activeKind);
}

function matchesQuery(snippet: PromptSnippet, q: string): boolean {
	if (q === '') return true;
	// Substring, not prefix as skills use: with ~100 entries named like
	// "Akira Toriyama Style", matching mid-name is the difference between
	// finding a snippet by typing ";tori" and having to recall its first word.
	return (
		snippet.name.toLowerCase().includes(q) || snippet.tags.some((t) => t.toLowerCase().includes(q))
	);
}

/**
 * Filter + order snippets for the autocomplete.
 *
 * The modality filter suppresses *clutter*, never *everything*: if filtering
 * by kind would empty an otherwise non-empty list, the unfiltered list is
 * returned instead. That's the "show all" escape hatch without a hidden
 * modifier key — a mis-tagged snippet can always still be reached, and the
 * user never faces an empty menu wondering whether the snippet exists.
 */
export function filterSnippets(
	snippets: PromptSnippet[],
	query: string,
	activeKind: SnippetKind | null,
): PromptSnippet[] {
	const q = query.toLowerCase();
	const matched = snippets.filter((s) => matchesQuery(s, q));
	const byKind = matched.filter((s) => matchesKind(s, activeKind));
	const out = byKind.length > 0 ? byKind : matched;
	// Most-used first, then alphabetical. Sort a copy — the caller's array is
	// the shared client-side cache.
	return [...out].sort((a, b) => b.usageCount - a.usageCount || a.name.localeCompare(b.name));
}
