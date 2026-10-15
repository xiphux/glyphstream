<!--
	Top-right corner badges on a gallery tile, in one flex row so a starred video
	shows both without the two overlapping. Display-only: starring happens in the
	lightbox, so a tile never has to compete with the select/delete hit areas in
	its other corner.

	Purely decorative, hence aria-hidden: a screen reader would otherwise read
	"Favorite" and "video" as separate stray labels next to each tile. The state
	they convey is spoken as part of each tile's own aria-label instead
	(", favorite" / ", N favorites"), so it is not visual-only.
-->
<script lang="ts">
	import { Star } from '@lucide/svelte';

	let { starred, isVideo }: { starred: boolean; isVideo: boolean } = $props();
</script>

{#if starred || isVideo}
	<div
		class="pointer-events-none absolute right-1.5 top-1.5 flex items-center gap-1"
		aria-hidden="true"
	>
		{#if starred}
			<span
				class="flex h-[18px] w-[18px] items-center justify-center rounded bg-black/60 text-favorite"
				title="Favorite"
			>
				<Star size={11} strokeWidth={2.5} fill="currentColor" />
			</span>
		{/if}
		{#if isVideo}
			<span
				class="rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-white"
			>
				video
			</span>
		{/if}
	</div>
{/if}
