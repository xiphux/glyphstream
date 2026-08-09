<!--
	Autocomplete list for prompt snippets. Presentational: SnippetAutocomplete
	owns the open/filter/highlight state and the keyboard handling; this just
	supplies the rows.

	The popover shell — positioning, scroll-into-view, and the mousedown
	focus-preservation trick — lives in AutocompleteMenu, shared with the skill
	menu. Preserving focus matters more here than there: the insertion point IS
	the caret, so a blur before selecting would lose it.

	Selecting a row inserts the snippet body at the caret — it never submits.
-->
<script lang="ts">
	import AutocompleteMenu from '$lib/components/chat/AutocompleteMenu.svelte';
	import type { PromptSnippet } from '$lib/types/api';

	interface Props {
		snippets: PromptSnippet[];
		highlightedIndex: number;
		onSelect: (snippet: PromptSnippet) => void;
		onHover: (index: number) => void;
	}

	let { snippets, highlightedIndex, onSelect, onHover }: Props = $props();
</script>

<AutocompleteMenu
	items={snippets}
	{highlightedIndex}
	label="Prompt snippets"
	key={(s: PromptSnippet) => s.id}
	{onSelect}
	{onHover}
>
	{#snippet row(s: PromptSnippet)}
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
	{/snippet}
</AutocompleteMenu>
