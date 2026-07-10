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
	const groups: (string | null)[] =
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
	/** The persisted assistant message, set on the branch's `done` event (or
	 *  hydrated from getSiblingAssistants on reload). */
	persisted: ChatMessage | null;
	/** Error text when status === 'error'. */
	error: string | null;
}

/** True once every column has reached a terminal state. */
export function allColumnsSettled(columns: readonly FanoutColumn[]): boolean {
	return columns.every(
		(c) => c.status === 'done' || c.status === 'error' || c.status === 'cancelled',
	);
}
