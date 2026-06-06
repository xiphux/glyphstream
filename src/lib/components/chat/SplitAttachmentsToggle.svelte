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

<button
	type="button"
	{disabled}
	aria-pressed={enabled}
	onclick={() => (enabled = !enabled)}
	title="Run the prompt on each attached image as its own generation"
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
