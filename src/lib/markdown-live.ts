/**
 * Client-side markdown rendering for in-flight assistant messages.
 *
 * Used during streaming — once the `done` event arrives we swap to the
 * server-rendered HTML (which has full-coverage shiki highlighting on
 * every language we ship server-side). To narrow the
 * unhighlighted→highlighted flash, the chat route lazy-loads a tiny
 * shiki subset (python + markdown grammars only, JS regex engine, no
 * wasm) via `markdown-live-shiki.svelte.ts` — the highlight callback
 * below picks it up the moment it's loaded. Anything outside that
 * subset still renders as plain `<pre><code>` during streaming and gets
 * the full highlight from the server once the message persists.
 *
 * Same renderer config as the server (link_open rewrite, html: false)
 * so the in-flight render and the post-done render look as close to
 * identical as possible — the only change on `done` is broader code
 * coverage.
 */

import MarkdownIt from 'markdown-it';
import {
	getLiveHighlighter,
	resolveLiveLang,
	liveHighlighterReady,
} from './markdown-live-shiki.svelte';

const LIGHT_THEME = 'github-light';
const DARK_THEME = 'github-dark';

let cached: MarkdownIt | null = null;

function getMd(): MarkdownIt {
	if (cached) return cached;
	const md = new MarkdownIt({
		html: false,
		linkify: true,
		typographer: false,
		breaks: false,
		highlight: (code, langSpec) => {
			const lang = resolveLiveLang(langSpec);
			if (!lang) return '';
			const h = getLiveHighlighter();
			if (!h) return '';
			try {
				return h.codeToHtml(code, {
					lang,
					themes: { light: LIGHT_THEME, dark: DARK_THEME },
					defaultColor: false,
				});
			} catch {
				return '';
			}
		},
	});
	const defaultLinkOpen =
		md.renderer.rules.link_open ??
		((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
	md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
		const token = tokens[idx];
		if (token.attrIndex('href') >= 0) {
			token.attrJoin('class', 'gs-link');
		}
		token.attrSet('target', '_blank');
		token.attrSet('rel', 'noopener noreferrer');
		return defaultLinkOpen(tokens, idx, options, env, self);
	};
	cached = md;
	return md;
}

/**
 * Render `text` as markdown. Safe to call on every streaming chunk —
 * markdown-it is stateless across calls and shiki's `codeToHtml` is
 * sync once the highlighter is loaded.
 *
 * Reads `liveHighlighterReady.value` so callers wrapped in `$derived`
 * automatically re-render the moment the lazy shiki chunk lands —
 * without it, an already-rendered streaming segment would stay plain
 * until the next text chunk arrived.
 */
export function renderLiveMarkdown(text: string): string {
	if (!text) return '';
	// Tracked read for $derived reactivity. Without this, segments that
	// finished arriving before shiki loaded would stay un-highlighted
	// until the next text chunk pushed them through markdown-it again.
	void liveHighlighterReady.value;
	return getMd().render(text);
}
