<!--
	One media tile: the thumbnail, its corner badges, a caption over a bottom
	gradient, and the selection ring and check mark. Shared by the gallery grid
	(a single item, or a unit's leader) and "Recently deleted", which used to draw
	three copies of it.

	The tile is one button, so what tapping it does is the page's (`onActivate`):
	open it, or toggle its selection. A second control sits in a corner as a
	sibling, since buttons don't nest: the page passes it as `action`.

	A tile never plays: the thumbnail endpoint serves a video's poster frame, so
	one <img> covers both kinds and skips the media element and its decoder. The
	corner badge marks a video.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import GalleryCornerBadges from '#lib/components/GalleryCornerBadges.svelte';

	let {
		thumbnailSrc,
		kind,
		alt,
		caption = null,
		captionBesideAction = false,
		favorite = false,
		showCheck,
		selected,
		dimUnselected = false,
		ariaLabel,
		ariaPressed,
		title,
		onActivate,
		action,
	}: {
		thumbnailSrc: string;
		kind: 'image' | 'video';
		alt: string;
		/** Text over the bottom gradient (the prompt, or time left in the trash). */
		caption?: string | null;
		/** Keep the caption clear of a bottom-right `action`. */
		captionBesideAction?: boolean;
		favorite?: boolean;
		/** Show the round check mark (select mode). */
		showCheck: boolean;
		selected: boolean;
		/** Dim the thumbnail until it is selected (the trash's look). */
		dimUnselected?: boolean;
		ariaLabel: string;
		ariaPressed?: boolean;
		title?: string;
		onActivate: () => void;
		/** A corner control beside the tile button: delete, or view full size. */
		action?: Snippet;
	} = $props();
</script>

<li
	data-tile
	class="group relative overflow-hidden rounded-lg border bg-surface-raised transition {selected
		? 'border-surface-inverse ring-2 ring-surface-inverse'
		: 'border-border hover:border-border-focus'}"
>
	<button
		type="button"
		onclick={onActivate}
		class="block w-full"
		aria-label={ariaLabel}
		aria-pressed={ariaPressed}
		{title}
	>
		<div class="relative aspect-square w-full overflow-hidden">
			<img
				src={thumbnailSrc}
				{alt}
				loading="lazy"
				class="h-full w-full object-cover {dimUnselected && !selected ? 'opacity-80' : ''}"
			/>
			<GalleryCornerBadges starred={favorite} isVideo={kind === 'video'} />
			{#if caption}
				<!-- The clamp is on an inner span, not this padded box: line-clamp
				     clips at the padding edge, so with it here the top of a third
				     line showed through the bottom padding. -->
				<div
					class="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/60 to-transparent pt-8 pb-1.5 pl-2 text-left text-xs text-white {captionBesideAction
						? 'pr-11'
						: 'pr-2'}"
				>
					<span class="line-clamp-2">{caption}</span>
				</div>
			{/if}
		</div>
	</button>
	{#if showCheck}
		<span
			aria-hidden="true"
			class="pointer-events-none absolute left-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full border-2 text-[12px] font-bold transition {selected
				? 'border-surface-inverse bg-surface-inverse text-fg-inverse'
				: 'border-white/80 bg-black/40 text-transparent'}"
		>
			✓
		</span>
	{/if}
	{@render action?.()}
</li>
