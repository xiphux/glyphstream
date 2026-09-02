/**
 * Client-side state for a multi-model fan-out: the user sends one prompt to
 * N models at once and each model's response streams into its own column.
 * The page owns an array of FanoutColumn and drives each from its own SSE
 * stream; FanoutColumns.svelte renders them side by side with pick/discard
 * controls once they settle.
 */

import type { InFlightSegment } from './chat-render';
import type { ChatMessage, ModelKind } from './types/api';

/**
 * Hard ceiling on concurrent fan-out branches per conversation. Each branch
 * holds an open SSE connection + an in-flight registry entry + (past the
 * per-endpoint `max_concurrent` gate) a queued waiter, so an unbounded fan-out
 * is a resource-exhaustion vector regardless of how the gate throttles the
 * actual upstream calls. 32 sits well above any realistic compare (≤~10 models)
 * or split cross-product (images × models) while bounding a single
 * conversation's standing queue. Enforced server-side (the route 429s past it)
 * and mirrored client-side (the controller refuses to dispatch an oversized
 * fan-out) so a legitimate user hits a friendly message, not a raw 429.
 */
export const MAX_FANOUT_BRANCHES_PER_CONVERSATION = 32;

export type FanoutColumnStatus = 'queued' | 'streaming' | 'done' | 'error' | 'cancelled';

/**
 * The pick-one vs keep-many policy split, by modality. Image and video fan-outs
 * are keep-many (regenerate/discard, every kept result stays a sibling); chat
 * (and embedding) are pick-one (promote one branch to the thread). The single
 * predicate for that distinction — used by the controller's grid-state derivation
 * and the compare view's layout.
 */
export function isMediaKind(kind: ModelKind | null | undefined): boolean {
	return kind === 'image' || kind === 'video';
}

/** One model picked for a fan-out comparison. The same model may appear more
 *  than once (e.g. to sample variations); each entry becomes its own column. */
export interface FanoutModel {
	modelId: string;
	modelKind: ModelKind;
	displayName: string;
}

/** A model + how many copies of it to compare — the model picker's compare
 *  state ("shopping cart" of counts). Expanded to one FanoutModel per count
 *  at send time via `expandCompareSelections`. */
export interface CompareSelection {
	modelId: string;
	count: number;
}

/** Expand `{ modelId, count }[]` into one FanoutModel per count, resolving
 *  each model's display name + kind via `resolve` (skips ones that no longer
 *  resolve — e.g. an endpoint removed from config since selection). */
/**
 * The model kind that's actually "active" for every kind-dependent piece of
 * composer UI — the placeholder, skill autocomplete, attachment/split
 * eligibility, and the feature toggles. The composer has two selection sources
 * (a single picked model and a multi-model compare cart) and they must not drift
 * the UI apart, so this is the one place that reconciles them: when a compare
 * SET is active it's the cart's kind, otherwise the single picked kind.
 *
 * Compare carts are kind-homogeneous — ModelPicker locks the cart to its first
 * model's kind ("you can't compare a chat reply with an image") — so the first
 * cart entry represents the whole cart. A null single kind (unknown) passes
 * through unchanged.
 */
export function resolveActiveModelKind(
	compareActive: boolean,
	cartKinds: readonly ModelKind[],
	singleKind: ModelKind | null,
): ModelKind | null {
	return compareActive && cartKinds.length > 0 ? cartKinds[0] : singleKind;
}

export function expandCompareSelections(
	selections: readonly CompareSelection[],
	resolve: (modelId: string) => { displayName: string; modelKind: ModelKind } | undefined,
): FanoutModel[] {
	const out: FanoutModel[] = [];
	for (const sel of selections) {
		const info = resolve(sel.modelId);
		if (!info) continue;
		for (let i = 0; i < sel.count; i++) {
			out.push({ modelId: sel.modelId, modelKind: info.modelKind, displayName: info.displayName });
		}
	}
	return out;
}

/**
 * Inverse of `expandCompareSelections`: collapse one FanoutModel per branch back
 * into `{ modelId, count }[]`, preserving first-seen order. Lossy by design —
 * `displayName` and `modelKind` are dropped, since both are re-resolved from
 * config wherever a cart is rehydrated.
 *
 * Takes the picked MODELS, never the post-cross-product branches: with split
 * attachments each model appears once per input image, so collapsing branches
 * would multiply every count by the image count.
 */
export function collapseToCompareSelections(models: readonly FanoutModel[]): CompareSelection[] {
	const byId = new Map<string, CompareSelection>();
	for (const m of models) {
		const existing = byId.get(m.modelId);
		if (existing) existing.count += 1;
		else byId.set(m.modelId, { modelId: m.modelId, count: 1 });
	}
	return [...byId.values()];
}

/** One concrete fan-out branch: a model paired with its (optional) split input
 *  image. The cross product of the picked models and the split images. */
export interface FanoutBranchSpec extends FanoutModel {
	/** Split-attachments input image for this branch, or null when not
	 *  splitting (the branch derives all the shared message's attachments). */
	inputMediaId: string | null;
}

/** Cross-product the picked models with the split input images. When
 *  `splitImageIds` is empty/null, splitting is off → one group per model with
 *  no input override (today's behavior). Ordered image-outer / model-inner, so
 *  each input image's variants sit together in the grid (and a single-model
 *  split reads as image 1, 2, 3, …). */
export function expandFanoutBranches(
	models: readonly FanoutModel[],
	splitImageIds: readonly string[] | null,
): FanoutBranchSpec[] {
	const groups: Array<string | null> =
		splitImageIds && splitImageIds.length > 0 ? [...splitImageIds] : [null];
	const out: FanoutBranchSpec[] = [];
	for (const inputMediaId of groups) {
		for (const m of models) {
			out.push({ ...m, inputMediaId });
		}
	}
	return out;
}

export interface FanoutColumn {
	/** Client-side unique id; also the in-flight branch key sent to the server. */
	branchId: string;
	modelId: string;
	modelKind: ModelKind;
	/** Column header label (the model's display name). */
	label: string;
	/** Live streaming segments until the branch settles. */
	segments: InFlightSegment[];
	status: FanoutColumnStatus;
	/** How many generations were ahead of this one in the endpoint's queue. */
	queuedAhead: number;
	/** Generation progress 0–100 for the poll-based video path, or null when
	 *  unknown / not a video branch. */
	progress: number | null;
	/** Transient phase label from a `progress` event's `status` (e.g.
	 *  "Enhancing prompt…" during the pre-generation prompt-enhancement pass),
	 *  shown in the column body in place of "Generating…". Null when there's no
	 *  active sub-phase. */
	statusLabel: string | null;
	/** Unix ms when this branch actually began generating (the SSE `start`
	 *  event, i.e. it acquired its concurrency slot), for the elapsed timer.
	 *  Null while queued / not yet started. */
	startedAt: number | null;
	/** Split-attachments: the input image this branch edits / animates, shown
	 *  as a thumbnail in the column header. Null for a non-split branch. */
	inputMediaId: string | null;
	/**
	 * This column's position in the grid, as dispatched — sent on the wire and
	 * persisted as the assistant row's `fanout_index`, so a grid rebuilt from
	 * server truth (reload, iOS suspend) comes back in the order the user
	 * enqueued the models instead of the order the endpoint finished them in.
	 *
	 * A re-roll takes its SOURCE column's index rather than a fresh one, which is
	 * what sorts it directly after the variation it re-rolled — the position the
	 * live grid inserts it at. So an index is NOT unique across columns: a shared
	 * one means "same variation group".
	 *
	 * Null on a column with no grid position to report. For the two PERSISTED
	 * cases — an avatar comparison's seeded portraits (drawn before this grid
	 * existed) and anything persisted before the column shipped — that means
	 * sorting ahead of every indexed column, chronologically, via
	 * `getSiblingAssistants`. A recovered placeholder for a still-generating
	 * branch is null too but isn't subject to that sort at all: it has no row
	 * yet, and `#buildRecoveredColumns` appends every placeholder AFTER every
	 * settled column, indexed or not. So it renders last, not first — and jumps
	 * to its index once it lands.
	 */
	dispatchIndex: number | null;
	/** The persisted assistant message, set on the branch's `done` event (or
	 *  hydrated from getSiblingAssistants on reload). */
	persisted: ChatMessage | null;
	/** Error text when status === 'error'. */
	error: string | null;
	/** Id of the durable error sibling a FAILED branch was recorded as, from the
	 *  `error` frame's `messageId` (or the recovered row's own id). A failure is
	 *  a real server-side row, so discarding the column has to delete it — with
	 *  only a local removal the "discarded" failure reappears the moment the grid
	 *  rebuilds from server truth (reload / iOS suspend).
	 *
	 *  Null when the branch hasn't failed and when it failed before anything was
	 *  persisted — but ALSO, on the live path, for a chat branch: the chat relay
	 *  persists an error sibling too (`persistTurnErrorSibling`), it just doesn't
	 *  report the row's id on the frame, because chat fan-out is pick-one and no
	 *  column offers discard. So null does NOT imply "nothing to delete", and
	 *  wiring discard for chat means plumbing `messageId` through `relay.ts`
	 *  first. Recovery is unaffected either way — it reads the id straight off
	 *  the persisted row, for both modalities. */
	errorMessageId: string | null;
}

/**
 * The grid position a fresh batch of branches should start numbering at: one
 * past the highest index already in the grid, or 0 when nothing is indexed.
 *
 * A turn fan-out always gets 0 (its anchor is a brand-new user message, so
 * there are no prior siblings). An avatar comparison anchors on a REUSED
 * assistant message, so a second draw round's portraits are siblings of the
 * first round's — numbered from 0 again they'd interleave with them in a grid
 * rebuilt from server truth instead of following them.
 */
export function nextDispatchIndex(columns: readonly FanoutColumn[]): number {
	let max = -1;
	for (const c of columns) {
		if (c.dispatchIndex !== null && c.dispatchIndex > max) max = c.dispatchIndex;
	}
	return max + 1;
}

/**
 * Where a re-roll of `source` belongs in the live grid: directly after it and
 * after any re-rolls it already has, so a variation and its re-rolls read as
 * one run. Columns of a group share `dispatchIndex` (a re-roll inherits its
 * source's), which is what makes the run identifiable.
 *
 * This is the live mirror of how `getSiblingAssistants` orders a recovered
 * grid — same index, then oldest-first. Placing every re-roll immediately
 * after the source instead would stack them newest-first live and
 * oldest-first after a reload.
 *
 * The two agree as long as a run's members COMPLETE in the order they were
 * rolled, which is the ordinary way re-rolls happen (roll, look, roll again).
 * They can disagree in the one case this whole column exists to handle: fire
 * two re-rolls of the same column at an endpoint that runs them in parallel,
 * and the server's `created_at` tiebreak within the shared index is once again
 * completion order — live shows [a, r1, r2], a reload shows [a, r2, r1].
 * Closing that would need a minor key under the shared index; a run is a
 * couple of columns wide, so it isn't worth one.
 *
 * An un-indexed source (an avatar comparison's seeded portrait) can't name a
 * run, so its re-roll just goes immediately after it.
 */
export function rerollInsertIndex(columns: readonly FanoutColumn[], source: FanoutColumn): number {
	const at = columns.findIndex((c) => c.branchId === source.branchId);
	if (at === -1) return columns.length;
	if (source.dispatchIndex === null) return at + 1;
	let i = at + 1;
	while (i < columns.length && columns[i].dispatchIndex === source.dispatchIndex) i++;
	return i;
}

/** True once every column has reached a terminal state. */
export function allColumnsSettled(columns: readonly FanoutColumn[]): boolean {
	return columns.every(
		(c) => c.status === 'done' || c.status === 'error' || c.status === 'cancelled',
	);
}

/**
 * The media a grid is currently SHOWING, in grid order: column order, then part
 * order within a column (a branch that returns a batch contributes all of it).
 * Branches with nothing on screen yet — queued, streaming, or failed —
 * contribute nothing.
 */
export function gridMediaIds(columns: readonly FanoutColumn[]): string[] {
	const out: string[] = [];
	for (const c of columns) {
		for (const p of c.persisted?.parts ?? []) {
			if (p.type === 'image' || p.type === 'video') out.push(p.mediaId);
		}
	}
	return out;
}

/**
 * Re-seat the members of `displayOrder` into the slots they already occupy in
 * `items`, leaving every other entry exactly where it was.
 *
 * The in-chat lightbox carousel is the conversation's media oldest-first, i.e.
 * COMPLETION order; a fan-out grid is displayed in the order the models were
 * ENQUEUED. Those agree only when the endpoint serializes the branches — run
 * them in parallel and it hands back 2, 4, 1, 3, so swiping through the
 * lightbox visited the same images in a different order than the grid the user
 * had just tapped. This makes the grid's order win for the images the grid
 * shows, without touching the surrounding chronology: only that group's members
 * move, and only among themselves.
 */
export function applyDisplayOrder<T extends { id: string }>(
	items: readonly T[],
	displayOrder: readonly string[],
): T[] {
	const byId = new Map(items.map((i) => [i.id, i]));
	const moving = new Set<string>();
	const ordered: T[] = [];
	for (const id of displayOrder) {
		const item = byId.get(id);
		// Skip ids the carousel set doesn't carry — a branch that landed after the
		// set was fetched — and any repeat, so the slot count below can't drift
		// from `ordered`.
		if (!item || moving.has(id)) continue;
		moving.add(id);
		ordered.push(item);
	}
	if (ordered.length < 2) return [...items];
	const out = [...items];
	let next = 0;
	for (let i = 0; i < out.length; i++) {
		if (moving.has(out[i].id) && next < ordered.length) out[i] = ordered[next++];
	}
	return out;
}
