/**
 * Sidebar favorites drag-and-drop state machine.
 *
 * Native HTML5 drag-drop — staying under the 250 KB bundle ceiling, the
 * list is small (~10s of items max), and the codebase already uses the
 * native API for image drops on the composer. The <li> carries
 * draggable="true"; the inner <a> has draggable="false" so its default
 * link-drag preview doesn't override the row's drag image. Click
 * navigation on the anchor is unaffected by draggable=false.
 *
 * Drop-position and auto-scroll math are split into pure helpers so
 * they can be unit-tested without a DOM. The class wraps them with the
 * reactive UI state ($state-tracked draggingValue / dropTargetValue /
 * dropPosition) the sidebar template binds against.
 */

import { reorder, reorderFavoriteModels } from './favorite-models';

/** Pixel distance from a scroll-pane edge inside which auto-scroll
 *  engages while dragging. Speed scales linearly from 0 at the edge of
 *  the zone to MAX_AUTO_SCROLL_SPEED at the very edge. */
const AUTO_SCROLL_EDGE_PX = 32;
const MAX_AUTO_SCROLL_SPEED = 12;

/** Whether a pointer at `clientY` over a row of geometry `rect` should
 *  drop *before* or *after* that row. Split out so the math is
 *  testable in isolation. */
export function computeDropPosition(
	clientY: number,
	rect: { top: number; height: number },
): 'before' | 'after' {
	return clientY < rect.top + rect.height / 2 ? 'before' : 'after';
}

/**
 * Pixels-per-frame the scroll pane should advance based on how close the
 * pointer is to the top/bottom of the container. Negative scrolls up.
 * Returns 0 when the pointer is outside both edge zones.
 */
export function computeAutoScrollSpeed(
	clientY: number,
	rect: { top: number; bottom: number },
	edgePx: number = AUTO_SCROLL_EDGE_PX,
	maxSpeed: number = MAX_AUTO_SCROLL_SPEED,
): number {
	const distFromTop = clientY - rect.top;
	const distFromBottom = rect.bottom - clientY;
	if (distFromTop >= 0 && distFromTop < edgePx) {
		const ratio = 1 - distFromTop / edgePx;
		return -Math.ceil(ratio * maxSpeed);
	}
	if (distFromBottom >= 0 && distFromBottom < edgePx) {
		const ratio = 1 - distFromBottom / edgePx;
		return Math.ceil(ratio * maxSpeed);
	}
	return 0;
}

export interface FavoritesDragDeps {
	/** The scrolling container — used for edge detection + auto-scroll
	 *  during long drags. Resolved per-call so the layout can `bind:` to
	 *  ScrollPane's slot ref without prop drilling through the class. */
	getScrollEl: () => HTMLElement | null;
	/** Current favorites order. Re-read on each drop so the reorder math
	 *  uses the most recent server-confirmed state, not a stale snapshot. */
	getCurrent: () => readonly string[];
}

export class FavoritesDrag {
	draggingValue = $state<string | null>(null);
	dropTargetValue = $state<string | null>(null);
	dropPosition = $state<'before' | 'after' | null>(null);
	/** Bind from the sidebar's <ul>: `<ul bind:this={favDrag.listEl}>`. */
	listEl = $state<HTMLUListElement | null>(null);

	#lastPointerY = 0;
	#autoScrollSpeed = 0;
	#autoScrollRaf: number | null = null;
	#deps: FavoritesDragDeps;

	constructor(deps: FavoritesDragDeps) {
		this.#deps = deps;
	}

	handleDragStart = (e: DragEvent, value: string): void => {
		if (!e.dataTransfer) return;
		this.draggingValue = value;
		e.dataTransfer.effectAllowed = 'move';
		// Some browsers (Firefox especially) require dataTransfer to
		// carry *something* for the drag to start.
		e.dataTransfer.setData('text/plain', value);
	};

	handleDragOver = (e: DragEvent, value: string): void => {
		if (this.draggingValue === null) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		this.#lastPointerY = e.clientY;
		this.#updateAutoScroll();
		// Don't render an indicator on the row being dragged itself —
		// no visible target for "dropped where it already is."
		if (value === this.draggingValue) {
			this.dropTargetValue = null;
			this.dropPosition = null;
			return;
		}
		this.dropTargetValue = value;
		this.dropPosition = computeDropPosition(
			e.clientY,
			(e.currentTarget as HTMLElement).getBoundingClientRect(),
		);
	};

	handleDragLeave = (e: DragEvent): void => {
		// `dragleave` fires on every row transition too; only clear when
		// the pointer actually exits the list (relatedTarget is outside
		// the <ul>, or null — happens when leaving the viewport).
		const related = e.relatedTarget as Node | null;
		if (!related || !this.listEl || !this.listEl.contains(related)) {
			this.dropTargetValue = null;
			this.dropPosition = null;
			this.#stopAutoScroll();
		}
	};

	handleDrop = async (e: DragEvent): Promise<void> => {
		e.preventDefault();
		const dragged = this.draggingValue;
		const target = this.dropTargetValue;
		const position = this.dropPosition;
		this.#resetDragState();
		if (!dragged || !target || !position) return;
		const current = this.#deps.getCurrent();
		const newOrder = reorder(current, dragged, target, position);
		if (newOrder.length === current.length && newOrder.every((v, i) => v === current[i])) {
			return;
		}
		await reorderFavoriteModels(newOrder);
	};

	handleDragEnd = (): void => {
		// Fires on drop-outside-list, ESC-cancel, or after a successful
		// drop — covers the cleanup gap if handleDrop didn't run.
		this.#resetDragState();
	};

	#resetDragState(): void {
		this.draggingValue = null;
		this.dropTargetValue = null;
		this.dropPosition = null;
		this.#stopAutoScroll();
	}

	#updateAutoScroll(): void {
		const scrollEl = this.#deps.getScrollEl();
		if (!scrollEl) {
			this.#autoScrollSpeed = 0;
			return;
		}
		const rect = scrollEl.getBoundingClientRect();
		this.#autoScrollSpeed = computeAutoScrollSpeed(this.#lastPointerY, rect);
		if (this.#autoScrollSpeed !== 0 && this.#autoScrollRaf === null) {
			this.#startAutoScrollLoop();
		} else if (this.#autoScrollSpeed === 0 && this.#autoScrollRaf !== null) {
			this.#stopAutoScroll();
		}
	}

	#startAutoScrollLoop(): void {
		const step = (): void => {
			const scrollEl = this.#deps.getScrollEl();
			if (this.#autoScrollSpeed === 0 || !scrollEl || this.draggingValue === null) {
				this.#autoScrollRaf = null;
				return;
			}
			scrollEl.scrollTop += this.#autoScrollSpeed;
			// The list is moving under the pointer; refresh the indicator
			// against the new geometry so it tracks the correct neighbor.
			this.#refreshDropTargetFromPointer();
			this.#autoScrollRaf = requestAnimationFrame(step);
		};
		this.#autoScrollRaf = requestAnimationFrame(step);
	}

	#stopAutoScroll(): void {
		if (this.#autoScrollRaf !== null) {
			cancelAnimationFrame(this.#autoScrollRaf);
			this.#autoScrollRaf = null;
		}
		this.#autoScrollSpeed = 0;
	}

	#refreshDropTargetFromPointer(): void {
		if (this.draggingValue === null || !this.listEl) return;
		const items = this.listEl.querySelectorAll<HTMLLIElement>(':scope > li');
		for (const li of items) {
			const rect = li.getBoundingClientRect();
			if (this.#lastPointerY >= rect.top && this.#lastPointerY <= rect.bottom) {
				const value = li.dataset.value ?? null;
				if (value && value !== this.draggingValue) {
					this.dropTargetValue = value;
					this.dropPosition = computeDropPosition(this.#lastPointerY, rect);
				} else {
					this.dropTargetValue = null;
					this.dropPosition = null;
				}
				return;
			}
		}
	}
}
