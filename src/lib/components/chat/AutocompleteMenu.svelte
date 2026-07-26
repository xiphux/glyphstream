<!--
	The shared shell for the composer's autocomplete menus (skills, snippets).

	Everything here is the part that has to behave identically no matter what
	the rows contain: the popover anchored above the composer, keeping the
	highlighted row scrolled into view, and — the subtle one — selecting on
	`mousedown` with `preventDefault()` rather than `click`, so the textarea
	never loses focus before the caller inserts. A click would blur first, and
	the insertion point would be gone.

	Rows are supplied by the caller through the `row` snippet, which is the only
	part that legitimately differs between menus.

	The generic is the item type; the caller supplies `key` so the keyed `#each`
	uses the item's real identity rather than an index (a positional key would
	recycle DOM between different items as the filter narrows).
-->
<script lang="ts" generics="T">
	import type { Snippet } from 'svelte';

	interface Props {
		items: T[];
		highlightedIndex: number;
		/** Accessible name for the listbox, e.g. "Skills". */
		label: string;
		key: (item: T) => string;
		onSelect: (item: T) => void;
		onHover: (index: number) => void;
		row: Snippet<[T]>;
	}

	let { items, highlightedIndex, label, key, onSelect, onHover, row }: Props = $props();

	let listEl = $state<HTMLDivElement | null>(null);

	// Keep the highlighted row visible as the user arrows through a long list
	// — with a ~100-entry snippet library this is load-bearing, not cosmetic.
	$effect(() => {
		const idx = highlightedIndex;
		const el = listEl?.querySelector<HTMLElement>(`[data-row-index="${idx}"]`);
		el?.scrollIntoView({ block: 'nearest' });
	});
</script>

{#if items.length > 0}
	<div
		bind:this={listEl}
		role="listbox"
		aria-label={label}
		class="surface-glass gs-pop absolute bottom-full left-1 z-50 mb-2 max-h-64 w-[min(28rem,calc(100%-0.5rem))] overflow-y-auto rounded-lg border border-border py-1 shadow-lg"
	>
		{#each items as item, i (key(item))}
			<button
				type="button"
				role="option"
				aria-selected={i === highlightedIndex}
				data-row-index={i}
				onmousedown={(e) => {
					// Prevent the textarea from losing focus before we insert.
					e.preventDefault();
					onSelect(item);
				}}
				onmouseenter={() => onHover(i)}
				class="flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left transition {i ===
				highlightedIndex
					? 'bg-surface-raised'
					: ''}"
			>
				{@render row(item)}
			</button>
		{/each}
	</div>
{/if}
