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
 *
 * markdown-it itself (~45 KB gzip) is dynamic-imported so login,
 * gallery, settings, and the home page never pay for it. The chat
 * route kicks the load off at mount via `ensureLiveMarkdown()`;
 * `renderLiveMarkdown()` falls back to an escaped <p>…</p> until the
 * chunk lands, which on a fast network is invisible because the first
 * tokens arrive after the import.
 */

import type MarkdownIt from 'markdown-it';
import {
	getLiveHighlighter,
	resolveLiveLang,
	liveHighlighterReady,
} from './markdown-live-shiki.svelte';

const LIGHT_THEME = 'github-light';
const DARK_THEME = 'github-dark';

let markdownItCtor: typeof MarkdownIt | null = null;
let cached: MarkdownIt | null = null;
let loadingPromise: Promise<typeof MarkdownIt | null> | null = null;

/**
 * Kick off the markdown-it lazy import. Idempotent — subsequent calls
 * return the in-flight or already-resolved promise. Resolves to null on
 * load failure; callers should keep using the plain-text fallback.
 *
 * Callers don't need to await this — `renderLiveMarkdown()` falls back
 * gracefully until the module lands and the next streaming tick picks
 * it up automatically.
 */
export function ensureLiveMarkdown(): Promise<typeof MarkdownIt | null> {
	if (loadingPromise) return loadingPromise;
	loadingPromise = (async () => {
		try {
			const mod = await import('markdown-it');
			markdownItCtor = mod.default;
			return markdownItCtor;
		} catch (err) {
			console.warn('Failed to load markdown-it for live rendering', err);
			return null;
		}
	})();
	return loadingPromise;
}

function build(Ctor: typeof MarkdownIt): MarkdownIt {
	const md = new Ctor({
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
	return md;
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
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
 *
 * Until the markdown-it chunk has landed, returns the raw text in an
 * escaped <p>. Streaming re-runs this on every tick so the next chunk
 * after the import resolves picks up the real render automatically.
 */
export function renderLiveMarkdown(text: string): string {
	if (!text) return '';
	// Tracked read for $derived reactivity. Without this, segments that
	// finished arriving before shiki loaded would stay un-highlighted
	// until the next text chunk pushed them through markdown-it again.
	void liveHighlighterReady.value;
	if (!markdownItCtor) {
		void ensureLiveMarkdown();
		return `<p>${escapeHtml(text)}</p>`;
	}
	if (!cached) cached = build(markdownItCtor);
	return cached.render(text);
}
