/**
 * Helpers that mutate the user's favorites list. The shared write path is
 * `setFavoriteModels` — both the picker's star button (toggle) and the
 * sidebar drag-and-drop (reorder) eventually call it with the new array.
 *
 * Treated as a fire-and-invalidate operation: we send the new list, then
 * trigger `invalidateAll()` so the layout reloads `data.prefs` and every
 * place that reads it (sidebar favorites section, picker favorites group,
 * star fill state on each row) re-renders consistently. We don't
 * optimistically update — the model picker's star fill is derived from
 * `data.prefs.favoriteModels`, and an optimistic local copy would briefly
 * disagree with the layout's snapshot during in-flight requests.
 *
 * The toast on failure surfaces the same error shape as the rest of the
 * app's mutation handlers; on success there's no toast (the visible state
 * change in sidebar/picker is its own feedback).
 */

import { invalidateAll } from '$app/navigation';
import { errorMessageFromResponse } from '$lib/fetch-error';
import { toast } from '$lib/toast.svelte';

async function setFavoriteModels(next: readonly string[]): Promise<void> {
	try {
		const res = await fetch('/api/user/preferences', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ favoriteModels: next }),
		});
		if (!res.ok) {
			toast.error(`Couldn't update favorites: ${await errorMessageFromResponse(res)}`);
			return;
		}
		await invalidateAll();
	} catch (e) {
		toast.error(`Couldn't update favorites: ${e instanceof Error ? e.message : String(e)}`);
	}
}

export async function toggleFavoriteModel(
	currentFavorites: readonly string[],
	modelValue: string,
): Promise<void> {
	const isFavorited = currentFavorites.includes(modelValue);
	const next = isFavorited
		? currentFavorites.filter((v) => v !== modelValue)
		: [...currentFavorites, modelValue];
	await setFavoriteModels(next);
}

export async function reorderFavoriteModels(newOrder: readonly string[]): Promise<void> {
	await setFavoriteModels(newOrder);
}

/**
 * Pure reorder math for drag-and-drop. Moves `dragged` so that it lands
 * immediately before or after `target` in `current`. Returns the input
 * unchanged when the move is a no-op or when either id isn't present —
 * keeps the drop handler tolerant of stale state without a try/catch.
 */
export function reorder(
	current: readonly string[],
	dragged: string,
	target: string,
	position: 'before' | 'after',
): string[] {
	if (dragged === target) return [...current];
	if (!current.includes(dragged) || !current.includes(target)) return [...current];
	const without = current.filter((v) => v !== dragged);
	const targetIdx = without.indexOf(target);
	const insertAt = position === 'before' ? targetIdx : targetIdx + 1;
	return [...without.slice(0, insertAt), dragged, ...without.slice(insertAt)];
}
