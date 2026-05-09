/**
 * Server-side markdown renderer with shiki code highlighting.
 *
 * Each rendered HTML string is cached on the message row's content_html
 * column at persist time, so reads are a single DB column lookup with no
 * markdown work on the hot path. Shiki's dual-theme output uses CSS vars
 * that respect prefers-color-scheme — one render serves both light/dark.
 *
 * Singleton highlighter (lazy init): shiki bundles ~150KB of grammar +
 * theme JSON, so we want one instance shared across all renders for the
 * lifetime of the process.
 */

import MarkdownIt from 'markdown-it';
import { createHighlighter, type Highlighter } from 'shiki';

const LIGHT_THEME = 'github-light';
const DARK_THEME = 'github-dark';

// Pre-load a useful default set. Languages outside this list fall back to
// plain `<pre><code>` (no highlighting); we accept that to keep startup
// time + memory bounded. Add more here as needed.
const PRELOADED_LANGS = [
	'bash',
	'c',
	'cpp',
	'css',
	'diff',
	'dockerfile',
	'go',
	'graphql',
	'html',
	'java',
	'javascript',
	'json',
	'jsx',
	'kotlin',
	'lua',
	'markdown',
	'php',
	'python',
	'ruby',
	'rust',
	'scss',
	'shell',
	'sql',
	'svelte',
	'swift',
	'toml',
	'tsx',
	'typescript',
	'vue',
	'xml',
	'yaml',
	'zig'
];

// Some common aliases users write that aren't shiki language ids.
const LANG_ALIASES: Record<string, string> = {
	js: 'javascript',
	ts: 'typescript',
	py: 'python',
	rb: 'ruby',
	rs: 'rust',
	sh: 'bash',
	yml: 'yaml'
};

let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
	if (!highlighterPromise) {
		highlighterPromise = createHighlighter({
			themes: [LIGHT_THEME, DARK_THEME],
			langs: PRELOADED_LANGS
		});
	}
	return highlighterPromise;
}

let mdPromise: Promise<MarkdownIt> | null = null;

async function getMarkdownIt(): Promise<MarkdownIt> {
	if (mdPromise) return mdPromise;
	mdPromise = (async () => {
		const highlighter = await getHighlighter();
		const loaded = new Set(highlighter.getLoadedLanguages());

		const md = new MarkdownIt({
			html: false, // raw HTML in source markdown is escaped
			linkify: true,
			typographer: false,
			breaks: false,
			highlight: (code, langSpec) => {
				const requested = (langSpec ?? '').trim().toLowerCase();
				const resolved = LANG_ALIASES[requested] ?? requested;
				if (resolved && loaded.has(resolved)) {
					try {
						return highlighter.codeToHtml(code, {
							lang: resolved,
							themes: { light: LIGHT_THEME, dark: DARK_THEME },
							defaultColor: false // emit CSS vars for both themes; no html-class flip needed
						});
					} catch {
						// fall through to default
					}
				}
				// Fallback: escape and wrap in plain pre/code so default rendering applies.
				return '';
			}
		});

		// Make all rendered links open in a new tab and disable referrer leakage.
		// Markdown-it's renderer-rule trick: wrap the existing link_open renderer.
		const defaultLinkOpen =
			md.renderer.rules.link_open ??
			((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
		md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
			const token = tokens[idx];
			const hrefIndex = token.attrIndex('href');
			if (hrefIndex >= 0) {
				token.attrJoin('class', 'gs-link');
			}
			token.attrSet('target', '_blank');
			token.attrSet('rel', 'noopener noreferrer');
			return defaultLinkOpen(tokens, idx, options, env, self);
		};

		return md;
	})();
	return mdPromise;
}

/**
 * Render `text` as markdown to a sanitized HTML string. Returns null when
 * `text` is empty (so callers can leave content_html null in the DB).
 *
 * markdown-it with `html: false` escapes any raw HTML in the source. The
 * trusted HTML we DO emit comes from shiki (we control it) — no
 * downstream sanitizer needed for v1's threat model (assistant output +
 * server-controlled rendering).
 */
export async function renderMarkdown(text: string): Promise<string | null> {
	const trimmed = text.trim();
	if (!trimmed) return null;
	const md = await getMarkdownIt();
	return md.render(text);
}
