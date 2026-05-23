/**
 * Toggle a model in the user's favorites list. Used by the model picker's
 * star button and any future "favorite this" affordance.
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

export async function toggleFavoriteModel(
	currentFavorites: readonly string[],
	modelValue: string
): Promise<void> {
	const isFavorited = currentFavorites.includes(modelValue);
	const next = isFavorited
		? currentFavorites.filter((v) => v !== modelValue)
		: [...currentFavorites, modelValue];

	try {
		const res = await fetch('/api/user/preferences', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ favoriteModels: next })
		});
		if (!res.ok) {
			toast.error(`Couldn't update favorites: ${await errorMessageFromResponse(res)}`);
			return;
		}
		await invalidateAll();
	} catch (e) {
		toast.error(
			`Couldn't update favorites: ${e instanceof Error ? e.message : String(e)}`
		);
	}
}
