/**
 * Copy buttons on rendered code blocks.
 *
 * Added to the HTML string at display time rather than by the markdown
 * renderers: a persisted message's `content_html` was rendered once and is
 * never re-rendered, so a button baked in server-side would appear only on
 * messages written after it shipped. Rewriting the string also leaves the DOM
 * alone — injecting nodes into an `{@html}` block would fight Svelte, which
 * owns those nodes and replaces them on every streaming frame.
 *
 * The click is handled by one delegated listener on the prose container
 * (`codeCopyClicks`, an attachment), since the buttons are plain HTML with no
 * handlers of their own. A listener rather than an `onclick` on the container
 * because the container isn't interactive — the buttons inside it are, and
 * their keyboard activation arrives as a click that bubbles here.
 */

// Every `<pre>` here came from markdown-it (`html: false`) or shiki, so source
// text can't forge one: a literal `<pre` or `</pre>` in the markdown arrives
// escaped. Code blocks don't nest, so the first `</pre>` closes the block.
const PRE_BLOCK = /<pre[\s>][\s\S]*?<\/pre>/g;

const ICON_ATTRS =
	'xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';

// Lucide's `copy` and `check`. CSS shows one or the other off `data-copied`.
const COPY_BUTTON =
	'<button type="button" class="gs-code-copy" aria-label="Copy code" title="Copy code">' +
	`<svg class="gs-code-copy-idle" ${ICON_ATTRS}><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>` +
	`<svg class="gs-code-copy-done" ${ICON_ATTRS}><path d="M20 6 9 17l-5-5"/></svg>` +
	'</button>';

/** Wrap every code block in `html` with a container holding a copy button. */
export function withCodeCopyButtons(html: string): string {
	if (!html.includes('<pre')) return html;
	return html.replace(PRE_BLOCK, (pre) => `<div class="gs-code">${COPY_BUTTON}${pre}</div>`);
}

const COPIED_MS = 1500;

/**
 * Delegated click handler for the buttons `withCodeCopyButtons` adds. Copies
 * the block's text as shown — markdown-it ends a fence's content with a
 * newline, which nobody wants on the clipboard, so one trailing newline goes.
 */
export async function handleCodeCopyClick(e: MouseEvent): Promise<void> {
	const button = (e.target as Element | null)?.closest?.('.gs-code-copy');
	if (!(button instanceof HTMLElement)) return;
	const pre = button.parentElement?.querySelector('pre');
	if (!pre) return;
	const text = (pre.textContent ?? '').replace(/\n$/, '');
	try {
		await navigator.clipboard.writeText(text);
	} catch (err) {
		// clipboard is unavailable outside a secure context (plain-http
		// self-hosting) and rejects when the document isn't focused. Select the
		// block instead, so a manual copy is one keystroke away.
		console.warn('Copy to clipboard failed:', err);
		const selection = window.getSelection();
		if (selection) {
			const range = document.createRange();
			range.selectNodeContents(pre);
			selection.removeAllRanges();
			selection.addRange(range);
		}
		return;
	}
	button.dataset.copied = '';
	button.setAttribute('aria-label', 'Copied');
	setTimeout(() => {
		delete button.dataset.copied;
		button.setAttribute('aria-label', 'Copy code');
	}, COPIED_MS);
}

/** Attachment for a prose container: routes its code-copy button clicks. */
export function codeCopyClicks(node: HTMLElement): () => void {
	const onClick = (e: MouseEvent) => void handleCodeCopyClick(e);
	node.addEventListener('click', onClick);
	return () => node.removeEventListener('click', onClick);
}
