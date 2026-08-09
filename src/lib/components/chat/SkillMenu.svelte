<!--
	Slash-command autocomplete for skills. Presentational: the parent
	(ComposerCore) owns the open/filter/highlight state and the keyboard
	handling (it owns the textarea keydown); this just supplies the rows.

	The popover shell — positioning, scroll-into-view, and the mousedown
	focus-preservation trick — lives in AutocompleteMenu, shared with the
	snippet menu so a fix to either applies to both.

	Selecting a row only completes the skill name into the box — it never
	submits.
-->
<script lang="ts">
	import AutocompleteMenu from '$lib/components/chat/AutocompleteMenu.svelte';

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
</script>

<AutocompleteMenu
	items={skills}
	{highlightedIndex}
	label="Skills"
	key={(s: SkillItem) => s.id}
	onSelect={(s: SkillItem) => onSelect(s.name)}
	{onHover}
>
	{#snippet row(s: SkillItem)}
		<span class="font-mono text-[13px] font-medium">/{s.name}</span>
		<span class="line-clamp-1 text-xs text-fg-muted">{s.description}</span>
	{/snippet}
</AutocompleteMenu>
