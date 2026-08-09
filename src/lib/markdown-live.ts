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

// markdown-it 15 ships its own types (the @types/markdown-it package stopped
// at 14 and is gone). Its default export is a *callable* value, not a class
// binding that doubles as a type — so the instance type is a separate named
// export and the constructor type has to come from `typeof` the default.
import type MarkdownItCtor from 'markdown-it';
import type { MarkdownIt } from 'markdown-it';
import {
	getLiveHighlighter,
	resolveLiveLang,
	liveHighlighterReady,
} from './markdown-live-shiki.svelte';

const LIGHT_THEME = 'github-light';
const DARK_THEME = 'github-dark';

let markdownItCtor: typeof MarkdownItCtor | null = null;
let cached: MarkdownIt | null = null;
let loadingPromise: Promise<typeof MarkdownItCtor | null> | null = null;

/**
 * Kick off the markdown-it lazy import. Idempotent — subsequent calls
 * return the in-flight or already-resolved promise. Resolves to null on
 * load failure; callers should keep using the plain-text fallback.
 *
 * Callers don't need to await this — `renderLiveMarkdown()` falls back
 * gracefully until the module lands and the next streaming tick picks
 * it up automatically.
 */
export function ensureLiveMarkdown(): Promise<typeof MarkdownItCtor | null> {
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

/**
 * Memo for highlighted fences, keyed on the exact (lang, code) pair.
 *
 * markdown-it invokes `highlight` for EVERY fence in the document on every
 * render, and streaming re-renders the whole accumulated message per frame. So
 * a reply that has already written three finished code blocks re-highlighted
 * all three ~60 times a second for the rest of the reply — at roughly 7ms per
 * 100-line block that's the entire frame budget spent re-producing identical
 * HTML while trailing prose streams in.
 *
 * Only the last fence in a streaming message is still growing; every earlier
 * one has stable text and so hits this cache forever after its first render.
 *
 * Budgeted by total cached characters rather than entry count because
 * highlighted HTML runs 5-20x the source: a fixed entry cap would bound the
 * count and not the memory. Eviction is LRU by access, which naturally keeps
 * the closed fences (re-requested every frame) and lets the growing fence's
 * superseded keys — a fresh one per frame — age out first.
 *
 * Partitioned per highlighter instance rather than global: the same (lang, code)
 * pair produces different HTML under a different highlighter, so a single map
 * would serve one highlighter's output for another's. Production only ever has
 * the one lazily-loaded singleton, but tests swap in stubs (including one that
 * throws, to assert the plain-`<pre>` fallback) and would otherwise read each
 * other's results. A WeakMap also means the entries die with the highlighter.
 */
const HIGHLIGHT_CACHE_MAX_CHARS = 2_000_000;
type HighlightCache = { entries: Map<string, string>; chars: number };
const highlightCaches = new WeakMap<object, HighlightCache>();

function cachedHighlight(owner: object, key: string, compute: () => string): string {
	let cache = highlightCaches.get(owner);
	if (!cache) {
		cache = { entries: new Map(), chars: 0 };
		highlightCaches.set(owner, cache);
	}
	const hit = cache.entries.get(key);
	if (hit !== undefined) {
		// Re-insert to mark most-recently-used (Map iterates in insertion order).
		cache.entries.delete(key);
		cache.entries.set(key, hit);
		return hit;
	}
	const html = compute();
	cache.entries.set(key, html);
	cache.chars += html.length;
	while (cache.chars > HIGHLIGHT_CACHE_MAX_CHARS) {
		const oldest = cache.entries.keys().next();
		if (oldest.done) break;
		cache.chars -= cache.entries.get(oldest.value)!.length;
		cache.entries.delete(oldest.value);
	}
	return html;
}

function build(Ctor: typeof MarkdownItCtor): MarkdownIt {
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
			return cachedHighlight(h, `${lang}:${code}`, () => {
				try {
					return h.codeToHtml(code, {
						lang,
						themes: { light: LIGHT_THEME, dark: DARK_THEME },
						defaultColor: false,
					});
				} catch {
					return '';
				}
			});
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
