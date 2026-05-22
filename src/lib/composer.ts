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
	const fromFiles = Array.from(source.files ?? []).filter((f) =>
		f.type.startsWith('image/')
	);
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
