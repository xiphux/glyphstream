<!--
	The small round portrait beside a model's name above its reply. Rendered
	only when the conversation or its preset has one — there is no
	per-base-model avatar, and no generic placeholder glyph: a conversation with
	neither keeps the bare label row it has always had.

	Points at the existing /thumbnail variant rather than a bespoke avatar
	endpoint. It maxes out at 512px, which is oversized for a 32px circle, but
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
		/** Opens the media lightbox for this avatar. Omit on surfaces with no
		 *  lightbox mounted (the settings list) and it renders as a plain,
		 *  non-interactive image. */
		onClick?: (mediaId: string) => void;
	}

	let { mediaId, label, onClick }: Props = $props();

	// Records WHICH avatar failed rather than a bare boolean, so `failed`
	// re-derives to false the moment the bubble is reused for a different
	// preset's avatar. A plain flag would need an effect to reset it, and an
	// effect that writes state is both the discouraged shape and a no-op
	// during SSR.
	let failedFor = $state<string | null>(null);
	const failed = $derived(failedFor === mediaId);
</script>

{#snippet portrait()}
	<!--
		alt="" on purpose: the label sits immediately beside it in the same row,
		so announcing the name twice is noise. `title` gives a hover affordance
		without adding anything to the accessibility tree that the text doesn't
		already say — and when this is wrapped in a button below, the button
		carries the accessible name instead.
	-->
	<img
		src="/api/media/{mediaId}/thumbnail"
		alt=""
		title={onClick ? undefined : label}
		width="32"
		height="32"
		loading="lazy"
		decoding="async"
		onerror={() => (failedFor = mediaId)}
		class="size-8 shrink-0 rounded-full object-cover ring-1 ring-black/10 dark:ring-white/15"
	/>
{/snippet}

{#if !failed}
	{#if onClick}
		<button
			type="button"
			onclick={() => onClick(mediaId)}
			title={label}
			aria-label="View avatar"
			class="shrink-0 cursor-zoom-in rounded-full transition hover:opacity-85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus"
		>
			{@render portrait()}
		</button>
	{:else}
		{@render portrait()}
	{/if}
{/if}
