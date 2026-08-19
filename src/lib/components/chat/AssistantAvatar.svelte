<!--
	The small round portrait beside a model's name above its reply. Rendered
	only for a custom-model preset that has one — there is no per-base-model
	avatar, and no generic placeholder glyph: a conversation without one keeps
	the bare label row it has always had.

	Points at the existing /thumbnail variant rather than a bespoke avatar
	endpoint. It maxes out at 512px, which is oversized for a 20px circle, but
	it's ONE url shared by every bubble in the conversation — the browser
	fetches it once and reuses it from cache down the whole thread — and it
	arrives with the same long Cache-Control as /content. A dedicated small
	variant is a later optimization, not a prerequisite.

	`failed` covers the case the media row outlived its bytes: the gallery can
	hard-delete an image that a preset still points at, which tombstones the
	row (the FK stays valid) and makes /thumbnail 404. Hiding on error degrades
	to the label-only bubble instead of a broken-image glyph.
-->
<script lang="ts">
	interface Props {
		mediaId: string;
		/** The name rendered next to this avatar. Feeds the hover `title` only —
		 *  the accessibility tree already gets it from the adjacent label, which
		 *  is why `alt` is empty. */
		label: string;
	}

	let { mediaId, label }: Props = $props();

	// Records WHICH avatar failed rather than a bare boolean, so `failed`
	// re-derives to false the moment the bubble is reused for a different
	// preset's avatar. A plain flag would need an effect to reset it, and an
	// effect that writes state is both the discouraged shape and a no-op
	// during SSR.
	let failedFor = $state<string | null>(null);
	const failed = $derived(failedFor === mediaId);
</script>

{#if !failed}
	<!--
		alt="" on purpose: the label sits immediately beside it in the same row,
		so announcing the name twice is noise. `title` gives a hover affordance
		without adding anything to the accessibility tree that the text doesn't
		already say.
	-->
	<img
		src="/api/media/{mediaId}/thumbnail"
		alt=""
		title={label}
		width="20"
		height="20"
		loading="lazy"
		decoding="async"
		onerror={() => (failedFor = mediaId)}
		class="size-5 shrink-0 rounded-full object-cover ring-1 ring-black/10 dark:ring-white/15"
	/>
{/if}
