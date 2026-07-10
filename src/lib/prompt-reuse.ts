/**
 * Cross-page handoff for a user message's "New chat from this prompt" action.
 *
 * The chat page writes an intent into sessionStorage, then navigates to /. The
 * new-chat page picks it up on mount, applies it to the composer + model picker
 * + attachments, and removes the key — a consume-and-clear flow so a
 * back-navigation doesn't re-trigger. It never submits: the whole point is to
 * tweak the prompt before sending.
 *
 * Deliberately a sibling of `gallery-launch.ts` rather than a third `kind` on
 * `GalleryLaunchIntent`: that union carries a single suggested model, whereas a
 * reused prompt carries a whole compare cart plus the source conversation's
 * feature toggles and private flag. Same sessionStorage rationale applies (see
 * that file) — prompts are long, and per-tab scope keeps two tabs from racing.
 */

import type { CompareSelection } from './fanout';
import type { FeatureCategory, ModelKind } from './types/api';

export const PROMPT_REUSE_KEY = 'glyphstream:promptReuse';

export interface PromptReuseIntent {
	/** The prompt's text parts, concatenated. May be empty for a media-only prompt. */
	text: string;
	/** Image attachments to re-reference by id (no re-upload). */
	mediaIds: string[];
	/** Picker-shape `endpointId::upstreamId`, or `custom::<id>` for a preset.
	 *  Null when nothing resolved — the receiver falls back to its own default. */
	modelId: string | null;
	/** Non-null ⇒ the receiver enters compare mode with this cart. */
	compareSelections: CompareSelection[] | null;
	disabledFeatures: FeatureCategory[];
	private: boolean;
}

/**
 * Rebuild a model selection from the prompt's recorded dispatch
 * (`ChatMessage.dispatchedModels`).
 *
 * `fallbackModelId` covers rows written before that column existed and OWUI
 * imports — pass the prompt's reply's `modelUsed`, then the conversation's
 * model. It is itself dropped if it doesn't resolve, leaving the receiver to
 * pick its own default rather than seeding a dead model.
 *
 * Entries that no longer resolve against the current config are dropped (same
 * contract as saved model sets). Survivors are then filtered to the first one's
 * kind, because compare carts are kind-homogeneous — ModelPicker locks the cart
 * to its first model's kind, so a cart mixing a chat and an image model would be
 * rejected on arrival. A kind can only go mixed if config changed a model's kind
 * out from under a recorded dispatch, so this is a repair path, not a hot one.
 */
export function deriveReuseModels(
	dispatched: CompareSelection[] | undefined,
	fallbackModelId: string | null,
	resolve: (modelId: string) => { kind: ModelKind } | undefined,
): { modelId: string | null; compareSelections: CompareSelection[] | null } {
	const resolved = (dispatched ?? []).filter((s) => resolve(s.modelId));
	const kind = resolved.length ? resolve(resolved[0].modelId)!.kind : null;
	const entries = resolved.filter((s) => resolve(s.modelId)!.kind === kind);

	if (entries.length === 0) {
		const usable = fallbackModelId && resolve(fallbackModelId) ? fallbackModelId : null;
		return { modelId: usable, compareSelections: null };
	}

	// Total branches, not distinct models: a 3× fan-out of one model is still a
	// comparison, and collapsing it to a single send would silently drop two
	// generations the user asked for.
	const total = entries.reduce((n, s) => n + s.count, 0);
	return {
		modelId: entries[0].modelId,
		compareSelections: total >= 2 ? entries.map((s) => ({ ...s })) : null,
	};
}

/**
 * Reconcile an intent against the receiving page's live model lists.
 *
 * `deriveReuseModels` already resolved everything at click time, but config can
 * change before the new-chat page mounts (an endpoint edited or health-flapped),
 * so nothing the intent carries can be trusted to still exist.
 *
 * The rule is that every model in the cart is one the user deliberately picked,
 * so a survivor always beats the page's own default. `intent.modelId` is the
 * cart's FIRST entry, which means it's exactly as mortal as any other — when it
 * is the one that vanished, adopt a survivor rather than falling through.
 * Falling through would be strictly worse than not filtering at all: the send
 * would go to an unrelated default instead of to a model the user chose.
 *
 * A cart that survives with fewer than two branches is no longer a comparison,
 * so it collapses to a single model. Returns the selection to apply; a null
 * `modelId` means "nothing usable survived — let the default-model effect pick".
 */
export function resolveIntentSelection(
	intent: Pick<PromptReuseIntent, 'modelId' | 'compareSelections'>,
	isKnown: (modelId: string) => boolean,
): { modelId: string | null; compareSelections: CompareSelection[] | null } {
	const cart = (intent.compareSelections ?? []).filter((s) => isKnown(s.modelId));
	const total = cart.reduce((n, s) => n + s.count, 0);
	const modelId =
		intent.modelId && isKnown(intent.modelId) ? intent.modelId : (cart[0]?.modelId ?? null);
	return { modelId, compareSelections: total >= 2 ? cart.map((s) => ({ ...s })) : null };
}

/**
 * Upgrade a base model id back to the `custom::<id>` preset the conversation was
 * created from, so a reused prompt keeps its system prompt and sampling params.
 *
 * Only applies when the chosen model IS the preset's base model: a conversation
 * started from a preset but since switched to another model must not have the
 * preset silently re-applied. Compare carts can't hold presets (they resolve
 * against the base model list), so this is a single-model concern only.
 */
export function upgradeToPresetModelId(
	modelId: string | null,
	customModelId: string | null,
	presets: readonly { id: string; baseEndpointId: string; baseModelId: string }[],
): string | null {
	if (!modelId || !customModelId) return modelId;
	const preset = presets.find((p) => p.id === customModelId);
	if (!preset) return modelId;
	return modelId === `${preset.baseEndpointId}::${preset.baseModelId}`
		? `custom::${preset.id}`
		: modelId;
}
