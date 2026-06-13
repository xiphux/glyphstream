/**
 * Helpers that mutate the user's saved multi-model sets — named groups of
 * models (e.g. "Favorite Image Models") that re-populate the model picker's
 * compare cart in one click. The shared write path is `setModelSets`, which
 * PATCHes the *full* `modelSets` array (the same fire-and-invalidate shape
 * as `favorite-models.ts`).
 *
 * Like favorites, this is fire-and-`invalidateAll`: we send the new array,
 * then reload `data.prefs` so every place that reads the sets (the picker's
 * "Saved sets" section) re-renders from the layout's snapshot. No optimistic
 * update — the picker reads sets from `data.prefs.modelSets`, and a local
 * optimistic copy would briefly disagree with the server during in-flight
 * requests. A toast surfaces failures; success is its own visible feedback.
 *
 * `mergeModelSet` is a pure helper (no I/O) so the picker can compute the
 * merged compare cart synchronously and unit-test the de-dupe in isolation,
 * mirroring `reorder` in `favorite-models.ts`.
 */

import { invalidateAll } from '$app/navigation';
import { errorMessageFromResponse } from '$lib/fetch-error';
import { toast } from '$lib/toast.svelte';
import type { CompareSelection } from '$lib/fanout';
import type { SavedModelSet } from '$lib/types/api';

async function setModelSets(next: readonly SavedModelSet[]): Promise<void> {
	try {
		const res = await fetch('/api/user/preferences', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ modelSets: next }),
		});
		if (!res.ok) {
			toast.error(`Couldn't update model sets: ${await errorMessageFromResponse(res)}`);
			return;
		}
		await invalidateAll();
	} catch (e) {
		toast.error(`Couldn't update model sets: ${e instanceof Error ? e.message : String(e)}`);
	}
}

/**
 * Append a new set built from the current compare cart. The name is trimmed;
 * selections are shallow-copied. No-ops (without writing) when the name is
 * blank or there are no selections — the caller should gate the UI, this is
 * belt-and-suspenders.
 */
export async function saveModelSet(
	current: readonly SavedModelSet[],
	name: string,
	selections: readonly CompareSelection[],
): Promise<void> {
	const trimmed = name.trim();
	if (!trimmed || selections.length === 0) return;
	const set: SavedModelSet = {
		id: crypto.randomUUID(),
		name: trimmed,
		models: selections.map((s) => ({ modelId: s.modelId, count: s.count })),
	};
	await setModelSets([...current, set]);
}

/** Remove a saved set by id and persist the result. */
export async function deleteModelSet(current: readonly SavedModelSet[], id: string): Promise<void> {
	await setModelSets(current.filter((s) => s.id !== id));
}

/**
 * Pure: merge a set's models into the current compare cart, de-duping by
 * modelId (the existing cart entry wins on collision — re-applying a set
 * that overlaps the cart doesn't compound counts). Returns a new array; the
 * input cart is not mutated. Used by the picker's apply-in-compare-mode path.
 */
export function mergeModelSet(
	cart: readonly CompareSelection[],
	set: SavedModelSet,
): CompareSelection[] {
	const seen = new Set(cart.map((s) => s.modelId));
	const out: CompareSelection[] = cart.map((s) => ({ ...s }));
	for (const m of set.models) {
		if (seen.has(m.modelId)) continue;
		seen.add(m.modelId);
		out.push({ modelId: m.modelId, count: m.count });
	}
	return out;
}
