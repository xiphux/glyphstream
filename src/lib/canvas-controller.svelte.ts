/**
 * Canvas pane controller — the client-side state for the side-by-side document
 * canvas(es). Deliberately thin: the server is authoritative (content + rendered
 * HTML live in the DB and arrive fully-formed), so this just holds the open
 * documents, which one is focused, whether the pane is open, and a transient
 * "just changed" marker for the highlight. Modelled on
 * fanout-controller.svelte.ts (a `$state` class the page hosts).
 *
 * A conversation can have several canvases; `docs` holds them in stable creation
 * order (as seeded) and `focusedId` selects which one the pane shows. Fed from
 * two places: `hydrate()` with the page-load seed (so a reload restores the
 * pane), and `apply()` from `onCanvasVersion` stream events during a turn.
 * Because every version carries server-rendered `contentHtml` (full shiki), the
 * pane renders that directly — no client markdown/highlight stack is pulled in.
 */

import type { CanvasVersion } from './types/api';

/** The page-load seed shape (from listActiveCanvases). A superset of what the
 *  pane needs; normalized to CanvasVersion on hydrate. `updatedAt` picks the
 *  initial focus (most-recently-touched). */
export interface CanvasSeed {
	id: string;
	title: string | null;
	content: string;
	contentHtml: string | null;
	currentVersionId: string | null;
	versionNumber: number;
	updatedAt: number;
}

export class CanvasController {
	/** Open documents, in stable creation order (the switcher's order). */
	docs = $state<CanvasVersion[]>([]);
	/** Which document the pane shows, by artifactId. */
	focusedId = $state<string | null>(null);
	/** Whether the pane is visible. */
	open = $state(false);
	/** The version id of the most recent edit, used to flash the pane briefly
	 *  after a change. Cleared by the pane once the highlight settles. */
	lastChangedVersionId = $state<string | null>(null);

	/** The currently-shown document, or null when there are none. */
	current = $derived(this.docs.find((d) => d.artifactId === this.focusedId) ?? null);

	/**
	 * Seed from the page load. Does NOT open the pane — whether to auto-open on
	 * entry is a viewport decision the page makes (side-by-side on desktop, but
	 * not full-screen-over-the-chat on mobile), so it calls `show()` itself when
	 * appropriate. Focus starts on the most-recently-updated canvas.
	 */
	hydrate(seeds: CanvasSeed[]): void {
		this.docs = seeds.map((s) => ({
			artifactId: s.id,
			versionId: s.currentVersionId ?? '',
			title: s.title,
			content: s.content,
			contentHtml: s.contentHtml,
			versionNumber: s.versionNumber,
			editSource: 'agent',
		}));
		this.focusedId =
			seeds.length > 0 ? seeds.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a)).id : null;
		this.open = false;
	}

	/** Apply a live edit from a canvas_version stream event: upsert the doc,
	 *  focus it, open the pane, and flag the change for the highlight. */
	apply(canvas: CanvasVersion): void {
		const idx = this.docs.findIndex((d) => d.artifactId === canvas.artifactId);
		if (idx >= 0) this.docs[idx] = canvas;
		else this.docs.push(canvas); // a newly created canvas appends (creation order)
		this.focusedId = canvas.artifactId;
		this.open = true;
		this.lastChangedVersionId = canvas.versionId;
	}

	/** Open the pane, optionally focusing a specific canvas (from a card click). */
	show(artifactId?: string): void {
		if (artifactId && this.docs.some((d) => d.artifactId === artifactId)) {
			this.focusedId = artifactId;
		}
		if (this.docs.length > 0) this.open = true;
	}

	/** Switch which canvas the pane shows, without changing open state. */
	focus(artifactId: string): void {
		if (this.docs.some((d) => d.artifactId === artifactId)) this.focusedId = artifactId;
	}

	hide(): void {
		this.open = false;
	}

	clearChangeFlag(): void {
		this.lastChangedVersionId = null;
	}
}
