/**
 * Canvas pane controller — the client-side state for the side-by-side document
 * canvas. Deliberately thin: the server is authoritative (content + rendered
 * HTML live in the DB and arrive fully-formed), so this just holds the current
 * document, whether the pane is open, and a transient "just changed" marker for
 * the highlight. Modelled on fanout-controller.svelte.ts (a `$state` class the
 * page hosts) but far smaller — Phase 1 is view-only, so there are no edit or
 * recovery actions yet.
 *
 * Fed from two places: `hydrate()` with the page-load seed (so a reload restores
 * the pane), and `apply()` from `onCanvasVersion` stream events during a turn.
 * Because every version carries server-rendered `contentHtml` (full shiki), the
 * pane renders that directly — no client markdown/highlight stack is pulled in.
 */

import type { CanvasVersion } from './types/api';

/** The page-load seed shape (from getActiveCanvas). A superset of what the pane
 *  needs; normalized to CanvasVersion on hydrate. */
export interface CanvasSeed {
	id: string;
	title: string | null;
	content: string;
	contentHtml: string | null;
	currentVersionId: string | null;
	versionNumber: number;
}

export class CanvasController {
	/** The current document, or null when the conversation has no canvas. */
	doc = $state<CanvasVersion | null>(null);
	/** Whether the pane is visible. Opens automatically when a canvas appears. */
	open = $state(false);
	/** The version id of the most recent edit, used to flash the pane briefly
	 *  after a change. Cleared by the pane once the highlight settles. */
	lastChangedVersionId = $state<string | null>(null);

	/**
	 * Seed from the page load. Does NOT open the pane — whether to auto-open on
	 * entry is a viewport decision the page makes (side-by-side on desktop, but
	 * not full-screen-over-the-chat on mobile), so it calls `show()` itself when
	 * appropriate.
	 */
	hydrate(seed: CanvasSeed | null): void {
		if (!seed) {
			this.doc = null;
			this.open = false;
			return;
		}
		this.doc = {
			artifactId: seed.id,
			versionId: seed.currentVersionId ?? '',
			title: seed.title,
			content: seed.content,
			contentHtml: seed.contentHtml,
			versionNumber: seed.versionNumber,
			editSource: 'agent',
		};
		this.open = false;
	}

	/** Apply a live edit from a canvas_version stream event. */
	apply(canvas: CanvasVersion): void {
		this.doc = canvas;
		this.open = true;
		this.lastChangedVersionId = canvas.versionId;
	}

	/** Re-open the pane after the user closed it (no content change). */
	show(): void {
		if (this.doc) this.open = true;
	}

	hide(): void {
		this.open = false;
	}

	clearChangeFlag(): void {
		this.lastChangedVersionId = null;
	}
}
