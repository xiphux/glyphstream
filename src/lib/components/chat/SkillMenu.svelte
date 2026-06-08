<!--
	Slash-command autocomplete for skills. Presentational: the parent
	(ComposerCore) owns the open/filter/highlight state and the keyboard
	handling (it owns the textarea keydown); this just renders the filtered
	list anchored above the composer and reports selection/hover.

	Selecting a row only completes the skill name into the box — it never
	submits. mousedown (not click) + preventDefault keeps textarea focus so
	the caret stays put after a click.
-->
<script lang="ts">
	interface SkillItem {
		id: string;
		name: string;
		description: string;
	}

	interface Props {
		skills: SkillItem[];
		highlightedIndex: number;
		onSelect: (name: string) => void;
		onHover: (index: number) => void;
	}

	let { skills, highlightedIndex, onSelect, onHover }: Props = $props();

	let listEl = $state<HTMLDivElement | null>(null);

	// Keep the highlighted row visible as the user arrows through a long list.
	$effect(() => {
		const idx = highlightedIndex;
		const el = listEl?.querySelector<HTMLElement>(`[data-skill-index="${idx}"]`);
		el?.scrollIntoView({ block: 'nearest' });
	});
</script>

{#if skills.length > 0}
	<div
		bind:this={listEl}
		role="listbox"
		aria-label="Skills"
		class="surface-glass gs-pop absolute bottom-full left-1 z-50 mb-2 max-h-64 w-[min(28rem,calc(100%-0.5rem))] overflow-y-auto rounded-lg border border-border py-1 shadow-lg"
	>
		{#each skills as s, i (s.id)}
			<button
				type="button"
				role="option"
				aria-selected={i === highlightedIndex}
				data-skill-index={i}
				onmousedown={(e) => {
					// Prevent the textarea from losing focus before we insert.
					e.preventDefault();
					onSelect(s.name);
				}}
				onmouseenter={() => onHover(i)}
				class="flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left transition {i ===
				highlightedIndex
					? 'bg-surface-raised'
					: ''}"
			>
				<span class="font-mono text-[13px] font-medium">/{s.name}</span>
				<span class="line-clamp-1 text-xs text-fg-muted">{s.description}</span>
			</button>
		{/each}
	</div>
{/if}
