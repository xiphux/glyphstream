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

<div
	class="pointer-events-none absolute -top-4 left-1/2 -translate-x-1/2 -translate-y-full transition-opacity {visible
		? 'opacity-100'
		: 'opacity-0'}"
>
	<button
		type="button"
		onclick={onClick}
		aria-label="Scroll to latest message"
		aria-hidden={!visible}
		tabindex={visible ? 0 : -1}
		class="pointer-events-auto flex h-9 w-9 items-center justify-center rounded-full border border-neutral-200 bg-white text-neutral-700 shadow-md transition hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700"
	>
		<ArrowDown size={16} strokeWidth={2.25} />
	</button>
</div>
