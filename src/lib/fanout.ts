/**
 * Client-side state for a multi-model fan-out: the user sends one prompt to
 * N models at once and each model's response streams into its own column.
 * The page owns an array of FanoutColumn and drives each from its own SSE
 * stream; FanoutColumns.svelte renders them side by side with pick/discard
 * controls once they settle.
 */

import type { InFlightSegment } from './chat-render';
import type { ChatMessage, ModelKind } from './types/api';

export type FanoutColumnStatus = 'queued' | 'streaming' | 'done' | 'error' | 'cancelled';

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
