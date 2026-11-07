<!--
	A character chat's scene, over the composer: where the two sides are now,
	and a switch that moves the next message to the other scene (`#lib/scenes.ts`).
	The page puts the marker on top of that message when it's sent, so the
	change is part of the thread — the model sees it where it happened, and a
	retry or a branch above it takes it back with everything else.
-->
<script lang="ts">
	import type { Scene } from '#lib/types/api.js';

	interface Props {
		/** The scene the thread is in now. */
		now: Scene;
		/** The scene the next message moves to, or null to stay. */
		next: Scene | null;
		disabled?: boolean;
	}

	let { now, next = $bindable(), disabled = false }: Props = $props();

	const other = $derived<Scene>(now === 'texting' ? 'in_person' : 'texting');
	// A switch asked for before the thread got there on its own (the model met
	// up first) has nothing left to do.
	const pending = $derived(next !== null && next !== now);
</script>

<div class="mb-1.5 flex items-center gap-2 px-1 text-xs text-fg-muted">
	<span>
		{#if pending}
			Your next message moves {other === 'in_person' ? 'in person' : 'to texting'}
		{:else}
			{now === 'in_person' ? 'In person' : 'Texting'}
		{/if}
	</span>
	<span aria-hidden="true">·</span>
	<button
		type="button"
		class="font-medium text-fg underline-offset-2 hover:underline disabled:opacity-50"
		aria-pressed={pending}
		{disabled}
		onclick={() => (next = pending ? null : other)}
	>
		{#if pending}
			Stay {now === 'in_person' ? 'in person' : 'texting'}
		{:else}
			{other === 'in_person' ? 'Meet up in person' : 'Switch to texting'}
		{/if}
	</button>
</div>
