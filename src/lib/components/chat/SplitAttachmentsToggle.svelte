<!--
	Toggle that fans the prompt out across the attached images: one image-edit /
	image-to-video generation per image, instead of all images in one. Composes
	with the model picker's "Multiple" mode as a cross product. Rendered to the
	right of the attachment thumbnails; the parent gates it on having 2+ image
	attachments and an image/video model.

	Stacked icon-over-label so it stays narrow (the attachment row is tight on
	mobile) while using the height the thumbnails already occupy. Off reads
	"Split"; on keeps the icon + highlight and the label becomes a compact "×N"
	(the cross-product total = images × models), which conveys the count without
	widening the button.
-->
<script lang="ts">
	import { Images } from '@lucide/svelte';

	interface Props {
		enabled: boolean;
		/** Ready image attachments — the per-image branch count. */
		imageCount: number;
		/** Effective model count (compare cart), for the cross-product total. */
		modelCount?: number;
		disabled?: boolean;
	}

	let { enabled = $bindable(), imageCount, modelCount = 1, disabled = false }: Props = $props();

	const total = $derived(imageCount * Math.max(1, modelCount));
</script>

<div class="group/split relative inline-flex">
	<button
		type="button"
		{disabled}
		aria-pressed={enabled}
		aria-label="Split: run the prompt on each attached image as its own generation"
		onclick={() => (enabled = !enabled)}
		class={[
			'inline-flex flex-col items-center justify-center gap-0.5 rounded-lg border px-2.5 py-1 leading-none transition disabled:opacity-50',
			enabled
				? 'border-accent bg-accent/10 text-accent'
				: 'border-border text-fg-muted hover:border-border-strong hover:text-fg-secondary',
		]}
	>
		<Images size={17} strokeWidth={2.25} />
		<span class="text-[10px] font-medium tabular-nums">{enabled ? `×${total}` : 'Split'}</span>
	</button>
	<!-- Hover popover restoring the clarity the terse label dropped (mirrors the
	     model picker's compare preview). Desktop-only — no hover on touch, where
	     the icon + tap-to-toggle is the affordance. -->
	<div
		class="pointer-events-none absolute bottom-full right-0 z-50 mb-1.5 hidden w-max max-w-[16rem] group-hover/split:block"
	>
		<div
			class="surface-glass gs-pop rounded-lg border border-border px-2.5 py-1.5 text-xs shadow-lg"
		>
			<div class="font-medium text-fg-secondary">Split per image</div>
			<div class="mt-0.5 text-fg-muted">
				{#if modelCount > 1}
					{imageCount} images × {modelCount} models = {total} generations
				{:else}
					Runs the prompt on each image separately
				{/if}
			</div>
		</div>
	</div>
</div>
