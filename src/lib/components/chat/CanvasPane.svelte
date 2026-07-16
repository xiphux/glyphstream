<!--
	Side-by-side canvas pane (Phase 1: view-only). Renders the current document
	the model is editing across turns. Content arrives as server-rendered HTML on
	each canvas_version event (and on page-load hydration), so this just draws it
	with the shared `gs-prose` styles — no client markdown/highlight stack. On
	desktop it docks as a right column; on mobile it's a full-screen overlay.
-->
<script lang="ts">
	import { X } from '@lucide/svelte';
	import { cubicOut } from 'svelte/easing';
	import type { CanvasVersion } from '$lib/types/api';

	interface Props {
		/** The document currently shown. */
		doc: CanvasVersion;
		/** All open canvases, for the switcher (a tab strip when >1). */
		docs: CanvasVersion[];
		/** True right after an edit lands, to flash the body briefly. */
		changed: boolean;
		onClose: () => void;
		/** Switch which canvas is shown. */
		onSwitch: (artifactId: string) => void;
		/** Called once the post-change highlight has settled. */
		onHighlightSettled: () => void;
	}

	let { doc, docs, changed, onClose, onSwitch, onHighlightSettled }: Props = $props();

	/**
	 * Slide the pane in/out. On a wide viewport it's a docked column, so we
	 * animate WIDTH (0 ↔ its natural width) — the chat column, being flex-1,
	 * reflows smoothly to fill, mirroring the left sidebar's width collapse. On a
	 * small viewport it's a full-screen overlay, so we slide it in from the right
	 * with a translate. Respects prefers-reduced-motion (duration 0).
	 *
	 * `--pane-w` pins the inner content at its full width for the whole width
	 * animation (the inner reads it, left-anchored + clipped) so the document
	 * text doesn't rewrap as the column grows/shrinks — it slides instead.
	 *
	 * Deliberately does NOT gate on prefers-reduced-motion: the left sidebar's
	 * collapse (a plain CSS transition) doesn't either, and matching it keeps the
	 * two panels consistent. This is a mild 200ms panel slide, not vestibular
	 * motion.
	 *
	 * Uses a per-frame `tick` (plain inline styles) rather than a `css` keyframe:
	 * Svelte compiles `css` into a Web Animations keyframe, and Safari's WAAPI
	 * rejects keyframes that contain a custom property (`--pane-w`), silently
	 * no-op'ing the whole animation — so the pane just snapped there. Setting the
	 * styles imperatively each frame sidesteps that and runs in every browser.
	 */
	function slidePane(node: HTMLElement, { duration = 200 }: { duration?: number } = {}) {
		const wide = window.matchMedia?.('(min-width: 768px)').matches ?? false;
		const width = node.offsetWidth;
		return {
			duration,
			easing: cubicOut,
			tick: (t: number) => {
				if (wide) {
					if (t < 1) {
						node.style.setProperty('--pane-w', `${width}px`);
						node.style.width = `${t * width}px`;
						node.style.minWidth = '0';
						node.style.maxWidth = 'none';
					} else {
						// Settle back to the class-driven responsive width.
						node.style.removeProperty('--pane-w');
						node.style.width = '';
						node.style.minWidth = '';
						node.style.maxWidth = '';
					}
				} else {
					node.style.transform = t < 1 ? `translateX(${(1 - t) * 100}%)` : '';
				}
			},
		};
	}

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
	class="fixed inset-0 z-40 flex h-full flex-col overflow-hidden border-border-strong bg-surface-panel md:relative md:inset-auto md:z-auto md:w-[45%] md:min-w-[22rem] md:max-w-2xl md:border-l"
	aria-label="Canvas"
	transition:slidePane
>
	<!-- Inner content held at `--pane-w` (the pane's full width) during the width
	     animation and LEFT-anchored (default flex placement), so it moves with the
	     growing column's left edge — a real slide — while its fixed width keeps
	     the text from rewrapping. Falls back to 100% at rest. -->
	<div class="flex h-full shrink-0 flex-col" style="width: var(--pane-w, 100%)">
		<header class="border-b border-border-strong">
			{#if docs.length > 1}
				<!-- Multiple canvases: a tab strip to switch between them. -->
				<div class="flex items-center gap-2 px-2 pt-2">
					<div class="flex min-w-0 flex-1 gap-1 overflow-x-auto pb-0.5" role="tablist">
						{#each docs as d (d.artifactId)}
							<button
								type="button"
								role="tab"
								aria-selected={d.artifactId === doc.artifactId}
								onclick={() => onSwitch(d.artifactId)}
								class="shrink-0 whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition {d.artifactId ===
								doc.artifactId
									? 'bg-surface-sunken text-fg'
									: 'text-fg-muted hover:bg-surface-sunken/60 hover:text-fg-secondary'}"
							>
								{d.title ?? 'Canvas'}
							</button>
						{/each}
					</div>
					<button
						type="button"
						onclick={onClose}
						aria-label="Close canvas"
						class="shrink-0 rounded-md p-1.5 text-fg-muted transition hover:bg-surface-sunken hover:text-fg"
					>
						<X size={18} />
					</button>
				</div>
				<p class="truncate px-4 pt-1.5 pb-2 text-xs text-fg-muted">Version {doc.versionNumber}</p>
			{:else}
				<div class="flex items-center gap-3 px-4 py-3">
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
				</div>
			{/if}
		</header>

		<div
			class="min-h-0 flex-1 overflow-y-auto px-5 py-4 transition-colors duration-500"
			class:flash
		>
			{#if doc.contentHtml}
				<div class="gs-prose">{@html doc.contentHtml}</div>
			{:else}
				<p class="text-sm italic text-fg-muted">This canvas is empty.</p>
			{/if}
		</div>
	</div>
</aside>

<style>
	.flash {
		background-color: color-mix(in oklab, var(--color-accent) 10%, transparent);
	}
</style>
