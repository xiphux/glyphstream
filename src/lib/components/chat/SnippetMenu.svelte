<!--
	Autocomplete list for prompt snippets. Presentational, mirroring SkillMenu:
	the parent (SnippetAutocomplete) owns the open/filter/highlight state and
	the keyboard handling, since it owns the textarea's keydown; this just
	renders the filtered list anchored above the composer and reports
	selection/hover.

	Selecting a row inserts the snippet body at the caret — it never submits.
	mousedown (not click) + preventDefault keeps textarea focus so the caret
	stays put after a click, which matters more here than for skills: the
	insertion point IS the caret.
-->
<script lang="ts">
	import type { PromptSnippet } from '$lib/types/api';

	interface Props {
		snippets: PromptSnippet[];
		highlightedIndex: number;
		onSelect: (snippet: PromptSnippet) => void;
		onHover: (index: number) => void;
	}

	let { snippets, highlightedIndex, onSelect, onHover }: Props = $props();

	let listEl = $state<HTMLDivElement | null>(null);

	// Keep the highlighted row visible as the user arrows through a long list
	// — a ~100-entry library makes this load-bearing, not cosmetic.
	$effect(() => {
		const idx = highlightedIndex;
		const el = listEl?.querySelector<HTMLElement>(`[data-snippet-index="${idx}"]`);
		el?.scrollIntoView({ block: 'nearest' });
	});
</script>

{#if snippets.length > 0}
	<div
		bind:this={listEl}
		role="listbox"
		aria-label="Prompt snippets"
		class="surface-glass gs-pop absolute bottom-full left-1 z-50 mb-2 max-h-64 w-[min(28rem,calc(100%-0.5rem))] overflow-y-auto rounded-lg border border-border py-1 shadow-lg"
	>
		{#each snippets as s, i (s.id)}
			<button
				type="button"
				role="option"
				aria-selected={i === highlightedIndex}
				data-snippet-index={i}
				onmousedown={(e) => {
					// Prevent the textarea from losing focus before we insert.
					e.preventDefault();
					onSelect(s);
				}}
				onmouseenter={() => onHover(i)}
				class="flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left transition {i ===
				highlightedIndex
					? 'bg-surface-raised'
					: ''}"
			>
				<span class="flex items-center gap-1.5">
					<span class="text-[13px] font-medium">{s.name}</span>
					{#each s.kinds as k (k)}
						<span class="rounded bg-surface-sunken px-1 py-0.5 text-[10px] text-fg-muted">{k}</span>
					{/each}
				</span>
				<!-- Slice before rendering: `line-clamp-1` is CSS-only, so the browser
			     lays out the WHOLE body and then clips it. With an 8000-char cap
			     that made menu-open cost scale with total body text rather than
			     row count. 160 chars is far more than the one visible line. -->
				<span class="line-clamp-1 text-xs text-fg-muted">{s.body.slice(0, 160)}</span>
			</button>
		{/each}
	</div>
{/if}
