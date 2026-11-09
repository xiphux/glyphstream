<!--
	The open body of FeatureTogglesMenu: one switch row per visible category,
	help text in an (i) tooltip. Split out so the menu can load it on first open —
	it's the only thing on the chat route that uses bits-ui's Switch and Tooltip,
	and the popover is closed on almost every page view. All state stays with the
	menu; this only renders it.
-->
<script lang="ts">
	import { Switch, Tooltip } from 'bits-ui';
	import { Info, Lock } from '@lucide/svelte';
	import type { FeatureCategory, FeatureCategoryEntry } from '#lib/types/api.js';

	interface Props {
		categories: readonly FeatureCategoryEntry[];
		/** A row the private seal locks off — shown but not toggleable. */
		isSealed: (category: FeatureCategory) => boolean;
		/** The state the switch should display (a sealed row always reads off). */
		displayEnabled: (category: FeatureCategory) => boolean;
		onToggle: (category: FeatureCategory, enabled: boolean) => void;
	}

	let { categories, isSealed, displayEnabled, onToggle }: Props = $props();
</script>

<Tooltip.Provider delayDuration={150} disableHoverableContent>
	<div class="shrink-0 px-3 pb-1.5 pt-3 text-xs font-medium uppercase tracking-wide text-fg-muted">
		This conversation
	</div>
	<!-- Scrolls instead of clipping when the list outgrows the viewport
	     (many built-ins + connected MCP servers). -->
	<div class="flex flex-col gap-0.5 overflow-y-auto overscroll-contain px-2 pb-2">
		{#each categories as meta (meta.id)}
			{@const sealed = isSealed(meta.id)}
			{@const enabled = displayEnabled(meta.id)}
			<!-- A <label> so a tap anywhere on the row toggles the switch — a
			     much bigger touch target than the switch alone (matters on
			     mobile). The Switch is FIRST in DOM so it's the label's
			     forwarded control; `order-last ml-auto` puts it back on the
			     right. The (i) tooltip trigger sits AFTER it in DOM, so a row
			     tap forwards to the switch, never the info button.
			     A private-sealed row is dimmed + not-allowed and its switch is
			     disabled — off and locked. -->
			<label
				class="flex items-center gap-1.5 rounded-md px-2 py-1.5 transition {sealed
					? 'cursor-not-allowed opacity-60'
					: 'cursor-pointer hover:bg-surface-raised'}"
			>
				<Switch.Root
					checked={enabled}
					disabled={sealed}
					onCheckedChange={(checked) => onToggle(meta.id, checked)}
					aria-label={meta.label}
					class="relative order-last ml-auto inline-flex h-5 w-9 shrink-0 items-center rounded-full transition data-[state=checked]:bg-surface-inverse data-[state=unchecked]:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface-panel disabled:cursor-not-allowed"
				>
					<Switch.Thumb
						class="block h-4 w-4 translate-x-0.5 rounded-full bg-surface-panel shadow-sm transition data-[state=checked]:translate-x-[1.125rem]"
					/>
				</Switch.Root>
				<span class="text-sm font-medium text-fg">{meta.label}</span>
				{#if sealed}
					<!-- Lock glyph so the reason a row is off-and-fixed reads at a
					     glance; the tooltip below carries the explanation. -->
					<Lock size={12} strokeWidth={2.25} class="shrink-0 text-fg-muted" />
				{/if}
				<Tooltip.Root>
					<Tooltip.Trigger
						aria-label={`About ${meta.label}`}
						class="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-fg-muted transition hover:text-fg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
					>
						<Info size={13} strokeWidth={2.25} />
					</Tooltip.Trigger>
					<Tooltip.Portal>
						<Tooltip.Content
							side="top"
							sideOffset={6}
							collisionPadding={12}
							class="z-popover-nested max-w-[16rem] rounded-md border border-border surface-glass gs-pop px-2.5 py-1.5 text-xs leading-snug text-fg-secondary shadow-lg"
						>
							{sealed ? 'Off in private chat — this chat is sealed off.' : meta.description}
						</Tooltip.Content>
					</Tooltip.Portal>
				</Tooltip.Root>
			</label>
		{/each}
	</div>
</Tooltip.Provider>
