<!--
	Context-budget bar shown just above the composer — where "do I have room for
	what I'm about to send?" is actually asked. Pairs the approximate context
	readout with the Compact action that frees it up.

	Right-aligned, in a frosted pill: the composer floats over the scrolling
	conversation, so the readout needs its own (glass) background to stay legible,
	and keeping it to the right leaves the space above where you're typing clear.
	The numbers sit at the far right (informational, not critical), with the
	Compact button just to their left (label hidden on mobile to save width).
	Conditionally rendered by the chat page via `showBudgetBar`.
-->
<script lang="ts">
	import { FoldVertical } from '@lucide/svelte';
	import { Popover } from 'bits-ui';
	import ContextBreakdownPanel from './ContextBreakdownPanel.svelte';

	interface Props {
		/** Approximate context size (tokensIn + tokensOut of the latest assistant
		 *  message). Hidden when 0. */
		contextTokenCount: number;
		/** The active model's total context window, when known → "N / max · P%". */
		contextWindow?: number | null;
		onCompact: () => void;
		/** Enables the Compact button; disabled when there's nothing to fold. */
		canCompact?: boolean;
		/** True while a compaction is in flight — shows a "Compacting…" state. */
		compacting?: boolean;
		/** Backs the itemized breakdown popover behind the readout. */
		conversationId: string;
		/** Bumped on each completed turn, so the open panel refetches instead of
		 *  showing the previous turn's numbers. */
		revision: number;
	}

	let {
		contextTokenCount,
		contextWindow = null,
		onCompact,
		canCompact = false,
		compacting = false,
		conversationId,
		revision,
	}: Props = $props();

	const tokenFmt = new Intl.NumberFormat();

	const budget = $derived(
		contextWindow && contextWindow > 0
			? {
					max: contextWindow,
					pct: Math.min(100, Math.round((contextTokenCount / contextWindow) * 100)),
				}
			: null,
	);
</script>

<div class="mb-2 flex justify-end px-1">
	<div
		class="surface-glass-soft flex items-center gap-1.5 rounded-lg border border-border px-2 py-1 text-xs text-fg-muted shadow-sm"
	>
		<button
			type="button"
			onclick={onCompact}
			disabled={!canCompact || compacting}
			aria-label={compacting ? 'Compacting…' : 'Compact conversation'}
			title={compacting
				? 'Compaction in progress…'
				: canCompact
					? 'Summarize earlier messages to free up context. The originals stay in the thread.'
					: 'Not enough conversation to compact yet — summarizing it wouldn’t free up much.'}
			class="flex items-center gap-1 rounded px-1 py-0.5 transition hover:bg-surface-raised disabled:opacity-40 disabled:hover:bg-transparent"
		>
			<FoldVertical class="h-3.5 w-3.5 {compacting ? 'animate-pulse' : ''}" />
			<!-- Label hidden on mobile (icon-only there to save width); shown sm+
				 so sighted keyboard users get a real affordance, not just a tooltip. -->
			<span class="hidden sm:inline">{compacting ? 'Compacting…' : 'Compact'}</span>
		</button>
		{#if contextTokenCount > 0}
			<Popover.Root>
				<!-- `class:` is not a valid directive on a component, so the near-full
				     warning colour rides the class string instead. -->
				<Popover.Trigger
					title="See what's using the context window"
					class="rounded px-1 py-0.5 tabular-nums transition hover:bg-surface-raised {budget !==
						null && budget.pct >= 90
						? 'text-warning'
						: ''}"
				>
					{#if budget !== null}
						{tokenFmt.format(contextTokenCount)} / {tokenFmt.format(budget.max)} tokens · {budget.pct}%
					{:else}
						{tokenFmt.format(contextTokenCount)} tokens
					{/if}
				</Popover.Trigger>
				<Popover.Portal>
					<Popover.Content
						sideOffset={6}
						align="end"
						avoidCollisions
						collisionPadding={{ top: 60, right: 12, bottom: 12, left: 12 }}
						onOpenAutoFocus={(e) => e.preventDefault()}
						class="z-50 max-h-[min(70vh,var(--bits-popover-content-available-height))] w-[min(340px,calc(100vw-1.5rem))] overflow-y-auto rounded-lg border border-border surface-glass gs-pop shadow-lg"
					>
						<ContextBreakdownPanel {conversationId} {revision} />
					</Popover.Content>
				</Popover.Portal>
			</Popover.Root>
		{/if}
	</div>
</div>
