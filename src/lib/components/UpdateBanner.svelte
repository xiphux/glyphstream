<script lang="ts">
	import { RefreshCw, X } from '@lucide/svelte';

	interface Props {
		onRefresh: () => void;
		onDismiss: () => void;
	}

	let { onRefresh, onDismiss }: Props = $props();
</script>

<!--
	Sticky bottom-center toast surfaced when the PWA service worker
	signals that a new version is waiting to activate. Clicking Refresh
	calls the registerSW-returned updateSW(true) which takes the new SW
	live and reloads the page. Dismissing just hides the toast for this
	session — the new SW stays waiting and will eventually activate on
	its own when all tabs close.

	role + aria-live=polite announces the update to screen readers without
	stealing focus from whatever the user is doing.
-->
<div
	role="status"
	aria-live="polite"
	class="fixed bottom-4 left-1/2 z-50 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-2 rounded-full border border-neutral-200 bg-white px-3 py-2 text-sm shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
	style="bottom: max(1rem, calc(env(safe-area-inset-bottom) + 0.5rem))"
>
	<RefreshCw size={14} strokeWidth={2.25} class="shrink-0 opacity-70" />
	<span class="whitespace-nowrap">A new version is available.</span>
	<button
		type="button"
		onclick={onRefresh}
		class="ml-1 rounded-full bg-neutral-900 px-3 py-1 text-xs font-medium text-white transition hover:bg-neutral-800 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
	>
		Refresh
	</button>
	<button
		type="button"
		onclick={onDismiss}
		aria-label="Dismiss update notification"
		title="Dismiss"
		class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
	>
		<X size={14} strokeWidth={2.25} />
	</button>
</div>
