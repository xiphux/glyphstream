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
	if (!(await copyText(text))) {
		// Nothing could write the clipboard. Select the block instead, so a
		// manual copy is one keystroke away.
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

/**
 * The async clipboard API exists only in a secure context, and a self-hosted
 * instance reached over plain http on a LAN address isn't one — Safari then
 * has no `navigator.clipboard` at all. `execCommand('copy')` is deprecated but
 * still works there, and in every browser, from inside a click. Its absence is
 * checked synchronously so that path runs within the click's user activation.
 */
async function copyText(text: string): Promise<boolean> {
	if (window.isSecureContext && navigator.clipboard) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch (err) {
			console.warn('Copy to clipboard failed:', err);
		}
	}
	return copyWithExecCommand(text);
}

function copyWithExecCommand(text: string): boolean {
	// A textarea rather than selecting the <pre>: the selection would carry the
	// fence's trailing newline. readonly keeps iOS from raising the keyboard.
	const previous = document.activeElement;
	const scratch = document.createElement('textarea');
	scratch.value = text;
	scratch.setAttribute('readonly', '');
	scratch.style.position = 'fixed';
	scratch.style.top = '0';
	scratch.style.opacity = '0';
	document.body.append(scratch);
	scratch.select();
	scratch.setSelectionRange(0, text.length);
	try {
		return document.execCommand('copy');
	} catch {
		return false;
	} finally {
		scratch.remove();
		// select() moved focus to the scratch textarea; hand it back.
		if (previous instanceof HTMLElement) previous.focus({ preventScroll: true });
	}
}

/** Attachment for a prose container: routes its code-copy button clicks. */
export function codeCopyClicks(node: HTMLElement): () => void {
	const onClick = (e: MouseEvent) => void handleCodeCopyClick(e);
	node.addEventListener('click', onClick);
	return () => node.removeEventListener('click', onClick);
}
