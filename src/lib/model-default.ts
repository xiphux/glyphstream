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

/** A preset id (`custom::<id>`) resolved to the composite id of its base model. */
function baseIdOf(favorite: string, presets: readonly PresetLike[]): string | null {
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
	for (const favorite of favorites) {
		const baseId = baseIdOf(favorite, presets);
		// A favourite naming a preset that no longer exists, or a model the
		// endpoint stopped advertising, is skipped rather than fatal — favourites
		// outlive both.
		if (baseId === null) continue;
		if (COMPOSABLE.has(models.find((m) => m.id === baseId)?.kind ?? '')) return favorite;
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
 * starting selection, every favourite (the sidebar renders their labels), and a
 * `?model=` target if the URL carries one.
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
