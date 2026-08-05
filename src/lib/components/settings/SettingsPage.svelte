<!--
	The shared shell every /settings/* page sits in: a full-height flex column,
	a fixed header (title + optional blurb + optional actions), and a scrolling
	content region.

	All nine settings pages had hand-rolled this identically — the same
	`flex h-full flex-col overflow-hidden`, the same
	`text-lg font-semibold tracking-tight` heading, the same
	`flex-1 overflow-y-auto px-4 py-4` region — with no shared component between
	them. Two of them (models, preferences) had drifted onto a flex header while
	the rest used a block one, a difference that renders identically because
	neither actually had header actions.

	The INNER container stays with the caller. It's the one part that genuinely
	varies (a max-w-2xl column, a max-w-5xl two-up grid, a bare card, a <form>),
	so hoisting it would only produce a prop that every page overrides.

	`description` is a snippet rather than a string because several blurbs carry
	markup — inline <code>, a link to another settings page.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		title: string;
		/** Blurb under the title. Rendered inside the muted <p>. */
		description?: Snippet;
		/** Right-aligned header content (buttons, counts). */
		actions?: Snippet;
		/**
		 * Overrides the scroll region's classes. The default fits eight of the
		 * nine pages; admin opts into its own vertical rhythm.
		 */
		contentClass?: string;
		children: Snippet;
	}

	let {
		title,
		description,
		actions,
		contentClass = 'flex-1 overflow-y-auto px-4 py-4',
		children,
	}: Props = $props();
</script>

<div class="flex h-full flex-col overflow-hidden">
	<header class="flex shrink-0 items-start justify-between gap-3 px-4 py-3">
		<!-- flex-1 + min-w-0 so the text block fills the row exactly as the old
		     block-level header did, and long titles truncate rather than shove
		     the actions off the edge. -->
		<div class="min-w-0 flex-1">
			<h1 class="text-lg font-semibold tracking-tight">{title}</h1>
			{#if description}
				<p class="text-xs text-fg-muted">{@render description()}</p>
			{/if}
		</div>
		{#if actions}
			<div class="shrink-0">{@render actions()}</div>
		{/if}
	</header>

	<div class={contentClass}>
		{@render children()}
	</div>
</div>
