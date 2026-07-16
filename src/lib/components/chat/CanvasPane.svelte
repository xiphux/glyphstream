<!--
	Side-by-side canvas pane (Phase 1: view-only). Renders the current document
	the model is editing across turns. Content arrives as server-rendered HTML on
	each canvas_version event (and on page-load hydration), so this just draws it
	with the shared `gs-prose` styles — no client markdown/highlight stack. On
	desktop it docks as a right column; on mobile it's a full-screen overlay.
-->
<script lang="ts">
	import { X } from '@lucide/svelte';
	import type { CanvasVersion } from '$lib/types/api';

	interface Props {
		doc: CanvasVersion;
		/** True right after an edit lands, to flash the body briefly. */
		changed: boolean;
		onClose: () => void;
		/** Called once the post-change highlight has settled. */
		onHighlightSettled: () => void;
	}

	let { doc, changed, onClose, onHighlightSettled }: Props = $props();

	let flash = $state(false);
	$effect(() => {
		// Re-run on each new version (not just the changed→true edge) so
		// consecutive edits each flash.
		void doc.versionId;
		if (!changed) return;
		flash = true;
		const t = setTimeout(() => {
			flash = false;
			onHighlightSettled();
		}, 900);
		return () => clearTimeout(t);
	});
</script>

<aside
	class="fixed inset-0 z-40 flex h-full flex-col border-border-strong bg-surface-panel md:relative md:inset-auto md:z-auto md:w-[45%] md:min-w-[22rem] md:max-w-2xl md:border-l"
	aria-label="Canvas"
>
	<header class="flex items-center gap-3 border-b border-border-strong px-4 py-3">
		<div class="min-w-0 flex-1">
			<h2 class="truncate text-sm font-semibold">{doc.title ?? 'Canvas'}</h2>
			<p class="text-xs text-fg-muted">Version {doc.versionNumber}</p>
		</div>
		<button
			type="button"
			onclick={onClose}
			aria-label="Close canvas"
			class="shrink-0 rounded-md p-1.5 text-fg-muted transition hover:bg-surface-sunken hover:text-fg"
		>
			<X size={18} />
		</button>
	</header>

	<div class="min-h-0 flex-1 overflow-y-auto px-5 py-4 transition-colors duration-500" class:flash>
		{#if doc.contentHtml}
			<div class="gs-prose">{@html doc.contentHtml}</div>
		{:else}
			<p class="text-sm italic text-fg-muted">This canvas is empty.</p>
		{/if}
	</div>
</aside>

<style>
	.flash {
		background-color: color-mix(in oklab, var(--color-accent) 10%, transparent);
	}
</style>
