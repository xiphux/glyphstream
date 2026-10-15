/**
 * What a composer shows and allows, derived from the model selection: which
 * models a send would go to, whether they need an image, the placeholder, the
 * split-attachments toggle, the `/skill` menu.
 *
 * The chat page's composer (`ChatComposer`) and the new-chat page each derived
 * all of this, and had to be told to "mirror" each other in comments. They call
 * these instead. Each resolves model ids its own way (the new-chat page through
 * custom presets), so these take resolved models, not ids.
 */
import type { ModelEntry, ModelKind } from '#lib/types/api.js';
import { imageAttachment, type ImageAttachment } from '#lib/model-capabilities.js';

/**
 * The model ids a send would dispatch to: the comparison cart when compare
 * mode has one (each id once), otherwise the single picked model.
 */
export function selectedModelIds(
	compareMode: boolean,
	cartModelIds: readonly string[],
	modelId: string,
): string[] {
	return compareMode && cartModelIds.length > 0 ? [...new Set(cartModelIds)] : [modelId];
}

/** Resolve ids to catalogue entries, dropping any the catalogue can't. */
export function resolveModels(
	ids: readonly string[],
	resolve: (id: string) => ModelEntry | undefined,
): ModelEntry[] {
	return ids.map(resolve).filter((m): m is ModelEntry => m !== undefined);
}

/**
 * Whether the send is blocked for want of an image: a selected model only
 * accepts one (upscalers, background removal, image-to-video) and none is
 * attached. Models with no reported capabilities never gate.
 */
export function selectionNeedsImage(
	selected: readonly ModelEntry[],
	readyImageCount: number,
): boolean {
	if (readyImageCount > 0) return false;
	return selected.some((m) => imageAttachment(m) === 'required');
}

/**
 * The composer's placeholder for the active kind, so an image-required model
 * doesn't invite a text-only prompt it can't act on. `chatPlaceholder` is the
 * page's own wording for a chat.
 */
export function composerPlaceholder(
	activeKind: ModelKind | null,
	attachment: ImageAttachment,
	hasImage: boolean,
	chatPlaceholder: string,
): string {
	if (activeKind === 'image') {
		if (attachment === 'required')
			return hasImage ? 'Describe the edit…' : 'Attach an image to edit…';
		return 'Describe an image to generate…';
	}
	if (activeKind === 'video') {
		if (attachment === 'required')
			return hasImage ? 'Describe the video…' : 'Attach an image to animate…';
		return 'Describe a video to generate…';
	}
	return chatPlaceholder;
}

/** Split-attachments (one generation per attached image) needs a media model
 *  and at least two images. */
export function canSplitAttachments(
	activeKind: ModelKind | null,
	readyImageCount: number,
): boolean {
	return (activeKind === 'image' || activeKind === 'video') && readyImageCount >= 2;
}

/**
 * The `/skill-name` menu: offered only in a chat with the `skills` category
 * on. Undefined means no menu.
 */
export function skillCommandsFor<T>(
	activeKind: ModelKind | null,
	disabledFeatures: readonly string[],
	enabledSkills: T[] | undefined,
): T[] | undefined {
	return activeKind === 'chat' && !disabledFeatures.includes('skills') ? enabledSkills : undefined;
}
