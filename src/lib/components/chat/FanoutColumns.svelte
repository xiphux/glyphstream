<!--
	Multi-model fan-out compare view. Renders the N branch responses side by
	side (horizontal scroll on narrow viewports) while they stream, then
	surfaces per-column actions once settled. Two modes, driven by which
	callbacks the parent passes:
	  - text (onPick): "Continue with this" promotes one branch to the active
	    thread, the rest stay as siblings.
	  - media keep-many (onDiscard + onRegenerate): prune the duds + re-roll in
	    place; every kept image/video stays a sibling.
	Purely presentational — the page owns the streams, column state, and the
	pick / discard / regenerate requests.
-->
<script lang="ts">
	import { Check, Trash2, RefreshCw, CircleAlert } from '@lucide/svelte';
	import { untrack } from 'svelte';
	import RenderBlocks from './RenderBlocks.svelte';
	import {
		inFlightToBlocks,
		messageToBlocks,
		type RenderBlock,
		type ToolResultEntry,
	} from '$lib/chat-render';
	import type { FanoutColumn } from '$lib/fanout';

	interface Props {
		columns: FanoutColumn[];
		/** Pick one column to continue the thread (text fan-out). When omitted,
		 *  no "Continue with this" button renders — media fan-out is keep-many. */
		onPick?: (column: FanoutColumn) => void;
		/** Discard (delete) a column. Wired for media fan-out (prune the duds). */
		onDiscard?: (column: FanoutColumn) => void;
		/** Re-roll a column in place with the same model/prompt (image). */
		onRegenerate?: (column: FanoutColumn) => void;
		onImageClick: (mediaId: string) => void;
		/** A pick/discard/regenerate request is in flight — disables the controls. */
		busy?: boolean;
	}

	let { columns, onPick, onDiscard, onRegenerate, onImageClick, busy = false }: Props = $props();

	// Fan-out branches are single-iteration with tools disabled, so there are
	// never tool_result rows to thread in — an empty map is correct.
	const EMPTY_TOOL_RESULTS = new Map<string, ToolResultEntry>();

	function blocksFor(c: FanoutColumn): RenderBlock[] {
		return c.persisted
			? messageToBlocks(c.persisted, EMPTY_TOOL_RESULTS)
			: inFlightToBlocks(c.segments);
	}

	// "Continue with this" is only meaningful once a column has a persisted
	// response. Regenerate/discard act on a settled column (done or failed),
	// never one that's still generating.
	function canPick(c: FanoutColumn): boolean {
		return c.status === 'done' && c.persisted !== null;
	}
	function isSettled(c: FanoutColumn): boolean {
		return c.status === 'done' || c.status === 'error' || c.status === 'cancelled';
	}

	// Media (image/video) fan-out is keep-many (regenerate/discard, no single pick).
	const isMedia = $derived(!onPick && (!!onDiscard || !!onRegenerate));
	const countNoun = $derived(isMedia ? 'variations' : 'models');

	// Ticking clock for the per-column elapsed timer (a branch counts up from its
	// `start` event — the moment it acquires its concurrency slot — like
	// single-image generation). Only runs while a branch is actively timing, so
	// a settled grid does no work.
	let now = $state(Date.now());
	const anyTiming = $derived(columns.some((c) => c.status === 'streaming' && c.startedAt !== null));
	$effect(() => {
		if (!anyTiming) return;
		const id = setInterval(() => untrack(() => (now = Date.now())), 200);
		return () => clearInterval(id);
	});
	function elapsed(c: FanoutColumn): number {
		return c.startedAt !== null ? (now - c.startedAt) / 1000 : 0;
	}

	// Layout differs by mode. Text reads best side-by-side (compare responses
	// left-to-right), so it scrolls horizontally. Images are bounded by the
	// conversation width, where a horizontal strip only shows a couple at once
	// — so they flow into a vertical grid (1-up on mobile, 2-up from sm) that
	// the user scrolls naturally with the rest of the thread.
	const containerClass = $derived(
		isMedia ? 'grid grid-cols-1 gap-3 sm:grid-cols-2' : 'flex gap-3 overflow-x-auto pb-2',
	);
	const articleClass = $derived(
		isMedia
			? 'flex w-full flex-col rounded-2xl border border-border bg-surface-raised'
			: 'flex min-w-[16rem] max-w-[22rem] flex-1 flex-col rounded-2xl border border-border bg-surface-raised',
	);
	// Text columns are equal-height (flex row) and scroll internally; image
	// cells size to their picture and grow the page instead.
	const bodyClass = $derived(
		isMedia ? 'px-3 py-2 text-sm' : 'min-h-[3rem] flex-1 overflow-y-auto px-3 py-2 text-sm',
	);
	// How many columns hold a real (persisted) result — the last one can't be
	// discarded (deleteBranch needs a sibling to fall back to). Errored columns
	// have no persisted row, so discarding them is a client-only cleanup.
	const persistedCount = $derived(columns.filter((c) => c.persisted !== null).length);
	function canDiscard(c: FanoutColumn): boolean {
		return isSettled(c) && !(c.persisted !== null && persistedCount <= 1);
	}
</script>

<section class="mt-2" aria-label="Model comparison">
	<div class="mb-1 px-1 text-[11px] font-medium uppercase tracking-wide text-fg-muted">
		Comparing {columns.length}
		{countNoun}
	</div>
	<div class={containerClass}>
		{#each columns as c (c.branchId)}
			{@const blocks = blocksFor(c)}
			<article class={articleClass}>
				<header
					class="flex items-center gap-2 border-b border-border px-3 py-2 text-[11px] font-medium tracking-wide"
				>
					{#if c.inputMediaId}
						<!-- Split-attachments: the input image this branch edits / animates,
						     so each result reads as "this input → this model". -->
						<img
							src="/api/media/{c.inputMediaId}/content"
							alt="Source input"
							class="h-6 w-6 shrink-0 rounded object-cover ring-1 ring-border"
						/>
					{/if}
					<span class="truncate text-fg-secondary" title={c.label}>{c.label}</span>
					<span class="flex-1"></span>
					{#if c.status === 'streaming' && c.progress !== null}
						<!-- Video poll-relay progress. -->
						<span class="font-mono tabular-nums text-fg-muted">{c.progress.toFixed(0)}%</span>
					{:else if c.status === 'streaming'}
						<!-- The queued / timer state lives in the body; the header just
						     carries a subtle "active" pulse. -->
						<span class="inline-flex gap-0.5 text-fg-muted" aria-label="Generating">
							<span class="animate-pulse">·</span>
							<span class="animate-pulse [animation-delay:120ms]">·</span>
							<span class="animate-pulse [animation-delay:240ms]">·</span>
						</span>
					{:else if c.status === 'error'}
						<span class="inline-flex items-center gap-1 text-red-600 dark:text-red-400">
							<CircleAlert size={12} /> Failed
						</span>
					{:else if c.status === 'cancelled'}
						<span class="text-fg-muted">Stopped</span>
					{/if}
				</header>

				<div class={bodyClass}>
					{#if blocks.length > 0}
						<RenderBlocks {blocks} {onImageClick} />
					{:else if c.status === 'error'}
						<p class="text-xs text-red-600 dark:text-red-400">{c.error ?? 'Generation failed'}</p>
					{:else if c.status === 'queued'}
						<!-- Waiting on the per-endpoint concurrency slot (e.g. a single-GPU
						     backend running one branch at a time). -->
						<p class="flex items-center gap-1.5 text-xs text-fg-muted">
							<span
								class="rounded bg-surface-sunken px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-fg-secondary"
							>
								Queued
							</span>
							{#if c.queuedAhead > 0}<span>{c.queuedAhead} ahead</span>{/if}
						</p>
					{:else}
						<!-- Actively generating: count up from when this branch acquired
						     its slot (the live one of a serialized fan-out), like single
						     image generation. -->
						<p class="flex items-center gap-2 text-xs text-fg-muted">
							<span>Generating…</span>
							{#if c.startedAt !== null && elapsed(c) >= 0.3}
								<span class="font-mono tabular-nums">{elapsed(c).toFixed(1)}s</span>
							{/if}
						</p>
					{/if}
				</div>

				{#if onPick || onRegenerate || onDiscard}
					<footer class="flex items-center gap-2 border-t border-border px-2 py-2">
						{#if onPick}
							<button
								type="button"
								onclick={() => onPick(c)}
								disabled={busy || !canPick(c)}
								class="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-surface-inverse px-3 py-1.5 text-xs font-medium text-fg-inverse transition hover:opacity-90 disabled:opacity-30"
							>
								<Check size={13} strokeWidth={2.5} /> Continue with this
							</button>
						{/if}
						{#if onRegenerate}
							<button
								type="button"
								onclick={() => onRegenerate(c)}
								disabled={busy || !isSettled(c)}
								title="Regenerate this variation"
								class="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-fg-secondary transition hover:bg-surface-sunken disabled:opacity-30"
							>
								<RefreshCw size={13} strokeWidth={2.5} /> Regenerate
							</button>
						{/if}
						{#if onDiscard}
							<button
								type="button"
								onclick={() => onDiscard(c)}
								disabled={busy || !canDiscard(c)}
								aria-label="Discard this response"
								title={c.persisted !== null && persistedCount <= 1
									? 'Keep at least one'
									: 'Discard'}
								class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-fg-muted transition hover:bg-surface-sunken hover:text-red-600 disabled:opacity-30 dark:hover:text-red-400"
							>
								<Trash2 size={14} />
							</button>
						{/if}
					</footer>
				{/if}
			</article>
		{/each}
	</div>
</section>
