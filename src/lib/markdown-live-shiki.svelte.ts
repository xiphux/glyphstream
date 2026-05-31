/**
 * Lazy client-side shiki for in-flight highlighting. Whole-shiki on the
 * client would tank the bundle (~500 KB raw / ~280 KB gzip), so we ship
 * a minimal subset behind a dynamic import:
 *
 *   - shiki/core + the *JavaScript* regex engine (NOT oniguruma) — the
 *     oniguruma wasm engine alone is +200 KB gzip even without grammars.
 *   - two language grammars: `python` (for the run_python tool argument
 *     view) and `markdown` (for the rare ```markdown ... ``` fences in
 *     assistant prose).
 *   - github-light + github-dark themes, emitting CSS variables so the
 *     same HTML works under both color schemes.
 *
 * Measured bundle: ~308 KB raw / ~72 KB gzip, delivered as a route-lazy
 * chunk dynamic-imported from the chat page only — login / list /
 * settings stay shiki-free. Server still uses the full shiki bundle with
 * the oniguruma engine for the persisted post-stream HTML (which covers
 * the full language set); the client subset only hides the
 * unhighlighted→highlighted flash for the two languages above.
 *
 * Anything outside python/markdown falls through to plain `<pre><code>`
 * during streaming and gets the server's full-coverage highlight once
 * the persisted message lands.
 *
 * Module shape: a `.svelte.ts` file so we can expose a $state-backed
 * ready signal — Svelte components $derived on it will re-run the moment
 * the chunk lands, swapping plain pre for highlighted HTML mid-stream
 * without any explicit re-render call.
 */

import type { HighlighterCore } from '@shikijs/types';

export type LiveLang = 'python' | 'markdown';

const LIGHT_THEME = 'github-light';
const DARK_THEME = 'github-dark';

// Reactive ready signal. Components $derived on `.value` re-run the
// moment the highlighter chunk lands, so the next streaming tick swaps
// from plain `<pre>` to highlighted HTML.
export const liveHighlighterReady = $state({ value: false });

let highlighterPromise: Promise<HighlighterCore | null> | null = null;
let highlighter: HighlighterCore | null = null;

/**
 * Triggers the lazy load of the live-highlighting bundle. Idempotent —
 * subsequent calls return the in-flight or already-resolved promise.
 * Resolves to null on load failure (network drop, etc.); callers should
 * treat null as "no highlighting available" and keep using the plain
 * fallback rather than throwing.
 */
export function ensureLiveHighlighter(): Promise<HighlighterCore | null> {
	if (highlighterPromise) return highlighterPromise;
	highlighterPromise = (async () => {
		try {
			const [core, engine, py, md, light, dark] = await Promise.all([
				import('shiki/core'),
				import('shiki/engine/javascript'),
				import('@shikijs/langs/python'),
				import('@shikijs/langs/markdown'),
				import('@shikijs/themes/github-light'),
				import('@shikijs/themes/github-dark'),
			]);
			const h = await core.createHighlighterCore({
				themes: [light.default, dark.default],
				langs: [py.default, md.default],
				engine: engine.createJavaScriptRegexEngine(),
			});
			highlighter = h;
			liveHighlighterReady.value = true;
			return h;
		} catch (err) {
			console.warn('Failed to load live syntax highlighter', err);
			return null;
		}
	})();
	return highlighterPromise;
}

/**
 * Returns the loaded highlighter or null if the lazy chunk hasn't
 * arrived yet. Safe to call before `ensureLiveHighlighter()` resolves —
 * callers just get null and should fall back to plain rendering.
 */
export function getLiveHighlighter(): HighlighterCore | null {
	return highlighter;
}

/**
 * One of the two grammars we ship in the client subset, or null. Useful
 * for callers that already know they want python (e.g., the run_python
 * streaming view) but want a typed gate to keep the union honest.
 */
export function resolveLiveLang(lang: string | undefined | null): LiveLang | null {
	const normalized = (lang ?? '').trim().toLowerCase();
	if (normalized === 'python' || normalized === 'py') return 'python';
	if (normalized === 'markdown' || normalized === 'md') return 'markdown';
	return null;
}

/**
 * Renders `code` to highlighted HTML using the lazy highlighter. Returns
 * null if the lazy chunk hasn't loaded yet, the lang isn't one of the
 * client subset, or shiki throws (a grammar edge case shouldn't crash
 * the chat). Callers should treat null as "show plain `<pre>` instead."
 */
export function highlightLiveCode(code: string, lang: LiveLang): string | null {
	const h = highlighter;
	if (!h) return null;
	try {
		return h.codeToHtml(code, {
			lang,
			themes: { light: LIGHT_THEME, dark: DARK_THEME },
			defaultColor: false,
		});
	} catch {
		return null;
	}
}

/** Test escape hatch: reset module state so each test starts cold. */
export function resetLiveHighlighterForTests(): void {
	highlighterPromise = null;
	highlighter = null;
	liveHighlighterReady.value = false;
}

/** Test escape hatch: inject a pre-built highlighter, flipping ready. */
export function setLiveHighlighterForTests(h: HighlighterCore | null): void {
	highlighter = h;
	highlighterPromise = Promise.resolve(h);
	liveHighlighterReady.value = h !== null;
}
