<!--
	Toggle that fans the prompt out across the attached images: one image-edit /
	image-to-video generation per image, instead of all images in one. Composes
	with the model picker's "Multiple" mode as a cross product, so the label
	surfaces the resulting generation count (images × models). Rendered under the
	attachment thumbnails; the parent gates it on having 2+ image attachments and
	an image/video model.
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
		'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition disabled:opacity-50',
		enabled
			? 'border-accent bg-accent/10 text-accent'
			: 'border-border text-fg-muted hover:border-border-strong hover:text-fg-secondary',
	]}
>
	<Images size={13} strokeWidth={2.25} />
	{#if enabled}
		Split · {total} generation{total === 1 ? '' : 's'}
	{:else}
		Split per image
	{/if}
</button>
