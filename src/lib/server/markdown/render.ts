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

// markdown-it 15's default export is a callable value, not a class binding
// that doubles as a type — the instance type is a separate named export.
import MarkdownItCtor, { type MarkdownIt, type Token } from 'markdown-it';
import { bundledLanguagesInfo, createHighlighter, type Highlighter } from 'shiki';
import { createLogger } from '../log.ts';

const log = createLogger('markdown');

const LIGHT_THEME = 'github-light';
const DARK_THEME = 'github-dark';

// The languages that get highlighting, plus every alias shiki defines for them
// (`zsh`, `md`, `c++`, `kt`…). Anything else falls back to plain
// `<pre><code>`. Add more here as needed.
//
// Only CORE_LANGS load with the highlighter; the rest load the first time a
// fence asks for one (see `loadFenceLanguages`). Preloading all of them cost
// ~110 MB of resident memory for grammars most servers never render. The set
// that CAN highlight is this whole list either way, so whether a grammar was
// loaded yet never changes what a message renders to.
const SUPPORTED_LANGS = [
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
	'zig',
];

const CORE_LANGS = ['python', 'bash', 'javascript', 'typescript', 'json', 'markdown'];

// Every shiki language id and alias → its canonical id. Fence tags, the
// supported set and grammar loads all go through it, so an alias is accepted
// exactly when its grammar is (`bash` and `zsh` are both `shellscript`).
const CANONICAL_LANG = new Map<string, string>();
for (const info of bundledLanguagesInfo) {
	CANONICAL_LANG.set(info.id, info.id);
	for (const alias of info.aliases ?? []) CANONICAL_LANG.set(alias, info.id);
}

let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
	if (!highlighterPromise) {
		highlighterPromise = createHighlighter({
			themes: [LIGHT_THEME, DARK_THEME],
			langs: CORE_LANGS,
		});
	}
	return highlighterPromise;
}

let mdPromise: Promise<MarkdownIt> | null = null;

async function getMarkdownIt(): Promise<MarkdownIt> {
	if (mdPromise) return mdPromise;
	mdPromise = (async () => {
		const highlighter = await getHighlighter();

		const md = new MarkdownItCtor({
			html: false, // raw HTML in source markdown is escaped
			linkify: true,
			typographer: false,
			breaks: false,
			highlight: (code, langSpec) => {
				const resolved = resolveLang(langSpec ?? '');
				// renderMarkdown loaded every supported fence language before
				// rendering, so a supported one is always loaded by now.
				if (resolved && SUPPORTED.has(resolved)) {
					try {
						return highlighter.codeToHtml(code, {
							lang: resolved,
							themes: { light: LIGHT_THEME, dark: DARK_THEME },
							defaultColor: false, // emit CSS vars for both themes; no html-class flip needed
						});
					} catch {
						// fall through to default
					}
				}
				// Fallback: escape and wrap in plain pre/code so default rendering applies.
				return '';
			},
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
/**
 * NOTE ON COST: `md.render()` and shiki's `codeToHtml` are fully synchronous
 * despite the async signature — the `await` above yields before the work, not
 * during it — so this occupies the event loop, and on a single-process server
 * that stalls every other in-flight request including other users' SSE
 * forwarding. It runs once per tool-loop iteration at each persist boundary.
 *
 * Measured before reaching for a worker thread, because the fix is expensive
 * (a pool, plus a shiki highlighter resident per worker) and the estimate it
 * would have been based on was wrong:
 *
 *   prose only (~1.5 KB)              0.2 ms
 *   30-line python fence              1.8 ms
 *   300-line python fence             8.2 ms
 *   1500-line python fence (~50 KB)  37.9 ms
 *   3 x 300-line fences + prose      21.9 ms
 *
 * So the realistic worst case is tens of milliseconds, comparable to one of the
 * synchronous SQLite queries this process already runs per request, and a
 * typical reply is 1-20 ms. Deferring it behind `setImmediate` would reorder the
 * stall without shortening it. Not worth a worker until replies get much larger
 * or concurrency much higher — re-measure with this table before assuming.
 */
export async function renderMarkdown(text: string): Promise<string | null> {
	const trimmed = text.trim();
	if (!trimmed) return null;
	const md = await getMarkdownIt();
	// `md.render` is parse + render; split so the fences come from the same
	// parse that renders, without parsing twice.
	const env = {};
	const tokens = md.parse(text, env);
	await loadFenceLanguages(md, tokens);
	return md.renderer.render(tokens, md.options, env);
}

const SUPPORTED = new Set(SUPPORTED_LANGS.map(resolveLang));

function resolveLang(langSpec: string): string {
	const requested = langSpec.trim().toLowerCase();
	return CANONICAL_LANG.get(requested) ?? requested;
}

/**
 * Load the grammar for every supported language a fence in `tokens` names and
 * the highlighter doesn't have yet. Highlighting runs synchronously inside
 * markdown-it's render, so the grammar has to be there before it starts.
 * Reads markdown-it's own fence tokens, which are flat however deeply the
 * fence is nested (a list item, a blockquote), and derives the language name
 * the way its fence renderer does, so it names exactly what `highlight` gets.
 */
async function loadFenceLanguages(md: MarkdownIt, tokens: Token[]): Promise<void> {
	const highlighter = await getHighlighter();
	const loaded = new Set(highlighter.getLoadedLanguages());
	const wanted = new Set<string>();
	for (const token of tokens) {
		if (token.type !== 'fence' || !token.info) continue;
		const lang = resolveLang(md.utils.unescapeAll(token.info).trim().split(/\s+/)[0]);
		if (SUPPORTED.has(lang) && !loaded.has(lang)) wanted.add(lang);
	}
	for (const lang of wanted) {
		try {
			await highlighter.loadLanguage(lang as Parameters<Highlighter['loadLanguage']>[0]);
		} catch (e) {
			// Leave it unloaded: codeToHtml throws for it and the fence renders
			// as plain code, as an unsupported language would.
			log.warn(`could not load the ${lang} grammar:`, e);
		}
	}
}

/**
 * Wrap `code` in a fenced block that nothing inside it can close. A fence
 * ends at a line of at least as many backticks as opened it, so the fence
 * is one longer than the longest backtick run in the code (minimum three).
 * Otherwise a line of ``` in the code ends the block early and the rest
 * renders as markdown.
 */
export function fenceCode(language: string, code: string): string {
	let longest = 0;
	for (const run of code.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
	const fence = '`'.repeat(Math.max(3, longest + 1));
	return `${fence}${language}\n${code}\n${fence}`;
}
