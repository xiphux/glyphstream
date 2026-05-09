/**
 * Client-side markdown rendering for in-flight assistant messages.
 *
 * Used only during streaming — once the `done` event arrives we swap to the
 * server-rendered HTML (which has full shiki code highlighting). This pass
 * is intentionally shiki-free so we don't ship the highlighter (~150KB+) to
 * the browser. Code blocks render as plain `<pre><code>` until done.
 *
 * Same renderer config as the server (link_open rewrite, html: false) so
 * the in-flight render and the post-done render look as close to identical
 * as possible — the only change on `done` is code-block coloring.
 */

import MarkdownIt from 'markdown-it';

let cached: MarkdownIt | null = null;

function getMd(): MarkdownIt {
	if (cached) return cached;
	const md = new MarkdownIt({
		html: false,
		linkify: true,
		typographer: false,
		breaks: false
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
 * Render `text` as markdown. Safe to call on every streaming chunk — markdown-it
 * is stateless across calls. Empty input returns empty string so the caller can
 * keep `{@html}` empty without wrapping markup.
 */
export function renderLiveMarkdown(text: string): string {
	if (!text) return '';
	return getMd().render(text);
}
