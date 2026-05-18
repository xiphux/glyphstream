/**
 * Cross-page handoff for the gallery's "Regenerate with this prompt"
 * and "Use as starting image" affordances.
 *
 * The originating surface (gallery's MediaLightbox or the in-chat
 * MediaLightbox) writes an intent into sessionStorage, then navigates
 * to /. The new-chat page picks it up on mount, applies it to the
 * composer + model picker + attachments, and removes the key — a
 * consume-and-clear flow so a back-navigation doesn't re-trigger.
 *
 * Why sessionStorage rather than query params: prompts can be long
 * (low-thousands of chars is normal, occasionally more for detailed
 * style descriptions) and URLs would be unwieldy to copy/paste-share
 * even though that's not really a feature we want for transient
 * launch intents. Per-tab scope is the right isolation for this use
 * case: two tabs launching different intents don't race on the same
 * key.
 *
 * The pattern mirrors the existing `glyphstream:pendingFirstMessage:*`
 * handoff between the new-chat surface and the chat-id page (see
 * (app)/+page.svelte ~line 125).
 */

export const GALLERY_LAUNCH_KEY = 'glyphstream:galleryLaunch';

export type GalleryLaunchIntent =
	| {
			kind: 'regenerate';
			/** Full prompt (preferred) or excerpt fallback. The originating
			 *  side guarantees this is non-empty before stashing. */
			prompt: string;
			/** Suggested model in the "endpointId::upstreamId" form. May be
			 *  null if the media row lacked source-model fields or the
			 *  originating model is no longer in config — receiver picks
			 *  its own default in that case. */
			sourceModelId: string | null;
	  }
	| {
			kind: 'starting-image';
			mediaId: string;
			sourceModelId: string | null;
	  };
