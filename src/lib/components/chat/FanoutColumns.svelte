<!--
	Multi-model fan-out compare view. Renders the N branch responses side by
	side (horizontal scroll on narrow viewports) while they stream, then
	surfaces "Continue with this" / discard controls on each once settled.
	Picking one promotes that branch to the active thread; discarding deletes
	a branch outright. Purely presentational — the page owns the SSE streams,
	column state, and the pick/discard requests.
-->
<script lang="ts">
	import { Check, Trash2, CircleAlert } from '@lucide/svelte';
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
		onPick: (column: FanoutColumn) => void;
		/** Per-column discard. Optional — when omitted (text fan-out in this
		 *  cut), the discard control is hidden; the image variation flow wires
		 *  it in a later phase. */
		onDiscard?: (column: FanoutColumn) => void;
		onImageClick: (mediaId: string) => void;
		/** A pick/discard request is in flight — disables the controls. */
		busy?: boolean;
	}

	let { columns, onPick, onDiscard, onImageClick, busy = false }: Props = $props();

	// Fan-out branches are single-iteration with tools disabled, so there are
	// never tool_result rows to thread in — an empty map is correct.
	const EMPTY_TOOL_RESULTS = new Map<string, ToolResultEntry>();

	function blocksFor(c: FanoutColumn): RenderBlock[] {
		return c.persisted
			? messageToBlocks(c.persisted, EMPTY_TOOL_RESULTS)
			: inFlightToBlocks(c.segments);
	}

	// "Continue with this" is only meaningful once a column has a persisted
	// response. Discarding stays available for errored/cancelled columns too
	// so the user can clear a failed branch.
	function canPick(c: FanoutColumn): boolean {
		return c.status === 'done' && c.persisted !== null;
	}
</script>

<section class="mt-2" aria-label="Model comparison">
	<div class="mb-1 px-1 text-[11px] font-medium uppercase tracking-wide text-fg-muted">
		Comparing {columns.length} models
	</div>
	<div class="flex gap-3 overflow-x-auto pb-2">
		{#each columns as c (c.branchId)}
			{@const blocks = blocksFor(c)}
			<article
				class="flex min-w-[16rem] max-w-[22rem] flex-1 flex-col rounded-2xl border border-border bg-surface-raised"
			>
				<header
					class="flex items-center gap-2 border-b border-border px-3 py-2 text-[11px] font-medium tracking-wide"
				>
					<span class="truncate text-fg-secondary" title={c.label}>{c.label}</span>
					<span class="flex-1"></span>
					{#if c.status === 'queued'}
						<span class="text-fg-muted"
							>Queued{c.queuedAhead > 0 ? ` · ${c.queuedAhead} ahead` : ''}</span
						>
					{:else if c.status === 'streaming'}
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

				<div class="min-h-[3rem] flex-1 overflow-y-auto px-3 py-2 text-sm">
					{#if blocks.length > 0}
						<RenderBlocks {blocks} {onImageClick} />
					{:else if c.status === 'error'}
						<p class="text-xs text-red-600 dark:text-red-400">{c.error ?? 'Generation failed'}</p>
					{:else}
						<p class="text-xs text-fg-muted">
							{c.status === 'queued' ? 'Waiting for a slot…' : 'Generating…'}
						</p>
					{/if}
				</div>

				<footer class="flex items-center gap-2 border-t border-border px-2 py-2">
					<button
						type="button"
						onclick={() => onPick(c)}
						disabled={busy || !canPick(c)}
						class="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-surface-inverse px-3 py-1.5 text-xs font-medium text-fg-inverse transition hover:opacity-90 disabled:opacity-30"
					>
						<Check size={13} strokeWidth={2.5} /> Continue with this
					</button>
					{#if onDiscard}
						<button
							type="button"
							onclick={() => onDiscard(c)}
							disabled={busy}
							aria-label="Discard this response"
							title="Discard"
							class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-fg-muted transition hover:bg-surface-sunken hover:text-red-600 disabled:opacity-30 dark:hover:text-red-400"
						>
							<Trash2 size={14} />
						</button>
					{/if}
				</footer>
			</article>
		{/each}
	</div>
</section>
