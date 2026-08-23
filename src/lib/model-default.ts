/**
 * Which model the new-chat composer starts on, and the slice of the catalogue
 * first paint needs to render it.
 *
 * Extracted so the SERVER can answer both questions. It used to be decided in
 * `(app)/+page.svelte` from `data.models`, which meant the whole catalogue had
 * to be in the document before the composer could show anything — and on an
 * endpoint like OpenRouter that catalogue is ~2000 entries and 558KB of JSON,
 * shipped into every page load to answer a question about roughly three of them.
 *
 * Pure, and shared rather than reimplemented, because the alternative is two
 * copies of a precedence rule that drift silently: the page would pick one model
 * and the server would trim for another, and the symptom would be a picker
 * showing something the user never chose.
 */

/** The fields of a ModelEntry this logic actually reads. */
export interface ModelLike {
	id: string;
	kind: string;
}

/** The fields of a custom-model preset this logic actually reads. */
export interface PresetLike {
	id: string;
	baseEndpointId: string;
	baseModelId: string;
}

const CUSTOM_PREFIX = 'custom::';

/** Kinds the composer can actually drive. */
const COMPOSABLE = new Set(['chat', 'image', 'video']);

/**
 * A preset id (`custom::<id>`) resolved to the composite id of its base model;
 * any other id passes through unchanged. Null when the preset is unknown.
 *
 * Exported because the CLIENT needs the same indirection: a preset is never in
 * the catalogue, so selecting one means fetching the model underneath it — the
 * thing that supplies its kind, capabilities and picker row.
 */
export function baseIdOf(favorite: string, presets: readonly PresetLike[]): string | null {
	if (!favorite.startsWith(CUSTOM_PREFIX)) return favorite;
	const preset = presets.find((p) => p.id === favorite.slice(CUSTOM_PREFIX.length));
	return preset ? `${preset.baseEndpointId}::${preset.baseModelId}` : null;
}

/**
 * The composer's starting selection: the first favourite whose underlying model
 * is composable, else the first chat model, then image, then video, else ''.
 *
 * Returns the FAVOURITE's id when one wins — which may be a `custom::` id, since
 * the preset is what the user picked, not its base.
 */
export function pickDefaultModelId(opts: {
	favorites: readonly string[];
	presets: readonly PresetLike[];
	models: readonly ModelLike[];
}): string {
	const { favorites, presets, models } = opts;
	// One pass to index, rather than a scan per favourite. The catalogue runs to
	// thousands of entries on an aggregator endpoint and a STALE favourite is an
	// expected case — it scans the whole array without finding anything, and this
	// runs on every layout load.
	const kindById = new Map(models.map((m) => [m.id, m.kind] as const));
	for (const favorite of favorites) {
		const baseId = baseIdOf(favorite, presets);
		// A favourite naming a preset that no longer exists, or a model the
		// endpoint stopped advertising, is skipped rather than fatal — favourites
		// outlive both.
		if (baseId === null) continue;
		if (COMPOSABLE.has(kindById.get(baseId) ?? '')) return favorite;
	}
	return (
		models.find((m) => m.kind === 'chat')?.id ??
		models.find((m) => m.kind === 'image')?.id ??
		models.find((m) => m.kind === 'video')?.id ??
		''
	);
}

/**
 * Base-model ids the first render needs, given what it will try to display: the
 * starting selection and every favourite (the sidebar renders their labels).
 *
 * `urlModelId` folds in a `?model=` target, and the production caller
 * deliberately does NOT pass one. Reading `url.searchParams` in a layout load
 * marks the `model` param as a dependency, which re-runs the whole load — and
 * re-serializes its payload — every time that param changes, i.e. on every tap of
 * a sidebar favourite. A deep link is instead resolved client-side by one small
 * `/api/models?ids=` request (see `tests/e2e/deferred-layout.spec.ts`), which
 * costs a round trip on a rare path instead of a re-run on a common one. The
 * parameter stays because the trade could go the other way for a different
 * caller; today only the unit tests exercise it.
 *
 * Everything else in the catalogue is picker-only and can arrive later. Returned
 * as ids rather than entries so the caller owns the lookup — the server trims
 * its own list with it, and a test can assert the set without building entries.
 */
export function firstPaintModelIds(opts: {
	favorites: readonly string[];
	presets: readonly PresetLike[];
	defaultModelId: string;
	urlModelId?: string | null;
}): Set<string> {
	const { favorites, presets, defaultModelId, urlModelId } = opts;
	const wanted = new Set<string>();
	for (const id of [...favorites, defaultModelId, urlModelId ?? '']) {
		if (!id) continue;
		const baseId = baseIdOf(id, presets);
		if (baseId !== null) wanted.add(baseId);
	}
	return wanted;
}
