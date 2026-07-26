/**
 * Shared composer-textarea helpers used by the new-chat composer, the
 * chat composer, and the inline message editor — the three places that
 * each had their own copy of the auto-resize routine and the
 * drag/paste image-extraction logic.
 */

/** Max rendered height of a composer textarea before it scrolls. */
export const COMPOSER_MAX_HEIGHT_PX = 240;

/**
 * Auto-grow a composer textarea to fit its content, capped at
 * COMPOSER_MAX_HEIGHT_PX (past which it scrolls). Resets the height to
 * "auto" first so scrollHeight reflects the content's natural height,
 * not a previously-set larger value. Call after every value change —
 * including programmatic ones — once the DOM has flushed.
 */
export function autoResizeTextarea(el: HTMLTextAreaElement): void {
	el.style.height = 'auto';
	el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT_PX)}px`;
	el.style.overflowY = el.scrollHeight > COMPOSER_MAX_HEIGHT_PX ? 'auto' : 'hidden';
}

/**
 * Replace `[start, end)` in a textarea with `insert`, as ONE undo unit.
 *
 * `document.execCommand('insertText')` is deprecated but is the only API that
 * writes the browser's *native* undo stack, so a mis-picked snippet or skill
 * disappears on a single Ctrl-Z instead of character by character. It also
 * fires a real `input` event, which keeps Svelte's `bind:value` in sync for
 * free — and, because the bound value updates, the composer's auto-resize
 * effect runs without an explicit `tick()`.
 *
 * The modern-looking alternative, `setRangeText()`, does NEITHER: no undo
 * entry and no `input` event. It is therefore the *wrong* tool here despite
 * being the un-deprecated one, and is used only as the fallback below — where
 * the manual event dispatch is what keeps the binding correct. Please don't
 * "modernize" this to setRangeText.
 */
export function replaceRange(
	el: HTMLTextAreaElement,
	start: number,
	end: number,
	insert: string,
): void {
	el.focus();
	el.setSelectionRange(start, end);
	const ok =
		typeof document !== 'undefined' &&
		typeof document.execCommand === 'function' &&
		document.execCommand('insertText', false, insert);
	if (ok) return;
	// happy-dom (which has no execCommand) and any browser that refuses:
	// correct text, non-atomic undo.
	el.setRangeText(insert, start, end, 'end');
	el.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Insert at the caret, replacing any selection. See `replaceRange`. */
export function insertAtCaret(el: HTMLTextAreaElement, insert: string): void {
	replaceRange(el, el.selectionStart, el.selectionEnd, insert);
}

/** True when a drag carries files (rather than text or a page element). */
export function dragHasFiles(e: DragEvent): boolean {
	return Array.from(e.dataTransfer?.types ?? []).includes('Files');
}

/**
 * Pull image files out of a drop or paste. Accepts the DataTransfer from
 * a drop event or the clipboard's DataTransfer from a paste, and returns
 * only the `image/*` files. Tries `.files` first (the drop case, and an
 * image paste in most browsers) and falls back to iterating `.items`.
 */
export function extractImageFiles(source: DataTransfer | null | undefined): File[] {
	if (!source) return [];
	const fromFiles = Array.from(source.files ?? []).filter((f) => f.type.startsWith('image/'));
	if (fromFiles.length > 0) return fromFiles;
	const out: File[] = [];
	for (const item of source.items ?? []) {
		if (item.kind === 'file' && item.type.startsWith('image/')) {
			const f = item.getAsFile();
			if (f) out.push(f);
		}
	}
	return out;
}
