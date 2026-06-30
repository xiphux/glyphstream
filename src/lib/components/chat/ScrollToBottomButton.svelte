<!--
	Scroll-to-latest affordance, anchored above the composer so it sits a
	fixed distance above it regardless of how tall the textarea has grown.
	Fades out (and goes aria-hidden + untabbable) when the user is already
	near the bottom of the message list.
-->
<script lang="ts">
	import { ArrowDown } from '@lucide/svelte';

	interface Props {
		/** True when the button should be shown (user has scrolled up). */
		visible: boolean;
		onClick: () => void;
	}

	let { visible, onClick }: Props = $props();
</script>

<!--
	Extra top clearance on mobile (-top-8) so this doesn't crowd the right-aligned
	context-budget pill / Compact button that sits at the top of the composer
	stack on narrow screens; desktop keeps the tighter -top-4 (the pill is far
	right there, clear of this centered button).
-->
<div
	class="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 -translate-y-full transition-opacity sm:-top-4 {visible
		? 'opacity-100'
		: 'opacity-0'}"
>
	<button
		type="button"
		onclick={onClick}
		aria-label="Scroll to latest message"
		aria-hidden={!visible}
		tabindex={visible ? 0 : -1}
		class="flex h-9 w-9 items-center justify-center rounded-full border border-border bg-surface-panel text-fg-secondary shadow-md transition hover:bg-surface-raised {visible
			? 'pointer-events-auto'
			: 'pointer-events-none'}"
	>
		<ArrowDown size={16} strokeWidth={2.25} />
	</button>
</div>
