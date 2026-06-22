<script lang="ts">
	import { bucketLabel, monthStartMs, type Granularity } from '$lib/gallery-date-buckets';

	interface Period {
		key: string; // 'YYYY-MM', newest-first
		count: number;
	}

	let {
		periods,
		activeKey = null,
		onjump,
		class: className = '',
	}: {
		periods: Period[];
		activeKey?: string | null;
		onjump: (key: string) => void;
		class?: string;
	} = $props();

	let railEl = $state<HTMLElement | null>(null);
	let dragging = $state(false);
	let dragMoved = $state(false);
	let bubbleKey = $state<string | null>(null);
	let bubbleY = $state(0);

	const monthLabel = (key: string) => bucketLabel(monthStartMs(key), 'month' as Granularity);
	const yearOf = (key: string) => key.slice(0, 4);

	// Index of the period nearest a clientY within the rail (ticks are evenly
	// distributed top→bottom, so tick i sits at i/(n-1)).
	function indexAt(clientY: number): number {
		if (!railEl || periods.length === 0) return 0;
		const r = railEl.getBoundingClientRect();
		const frac = r.height > 0 ? (clientY - r.top) / r.height : 0;
		const i = Math.round(frac * (periods.length - 1));
		return Math.min(periods.length - 1, Math.max(0, i));
	}

	function updateBubble(clientY: number) {
		if (!railEl) return;
		const i = indexAt(clientY);
		bubbleKey = periods[i]?.key ?? null;
		bubbleY = clientY - railEl.getBoundingClientRect().top;
	}

	function onPointerDown(e: PointerEvent) {
		dragging = true;
		dragMoved = false;
		railEl?.setPointerCapture(e.pointerId);
		updateBubble(e.clientY);
	}

	function onPointerMove(e: PointerEvent) {
		if (!dragging) return;
		dragMoved = true;
		updateBubble(e.clientY);
	}

	function onPointerUp(e: PointerEvent) {
		if (!dragging) return;
		dragging = false;
		railEl?.releasePointerCapture(e.pointerId);
		if (dragMoved) {
			const key = periods[indexAt(e.clientY)]?.key;
			if (key) onjump(key);
			// Leave dragMoved=true so the synthetic click that follows a drag is
			// swallowed by the button handler below; it resets it.
		}
		bubbleKey = null;
	}

	// Discrete activation (mouse click without a drag, plus keyboard Enter/Space
	// on a focused tick). A drag's trailing click is suppressed via dragMoved.
	function onTickClick(key: string) {
		if (dragMoved) {
			dragMoved = false;
			return;
		}
		onjump(key);
	}
</script>

{#if periods.length > 0}
	<div
		bind:this={railEl}
		class="flex touch-none flex-col justify-between py-2 select-none {className}"
		onpointerdown={onPointerDown}
		onpointermove={onPointerMove}
		onpointerup={onPointerUp}
		onpointercancel={onPointerUp}
		role="presentation"
	>
		{#each periods as p, i (p.key)}
			{@const yearBoundary = i === 0 || yearOf(p.key) !== yearOf(periods[i - 1].key)}
			<button
				type="button"
				onclick={() => onTickClick(p.key)}
				aria-label="Jump to {monthLabel(p.key)}"
				class="group flex items-center justify-end gap-1 outline-none"
			>
				{#if yearBoundary}
					<span class="text-[9px] leading-none text-fg-muted tabular-nums">{yearOf(p.key)}</span>
				{/if}
				<span
					class="block rounded-full transition-all group-hover:bg-fg-default group-focus-visible:bg-fg-default {p.key ===
					activeKey
						? 'h-1 w-3 bg-fg-default'
						: 'h-px bg-border-strong'} {yearBoundary ? 'w-3' : 'w-2'}"
				></span>
			</button>
		{/each}
	</div>

	{#if dragging && bubbleKey}
		<div
			class="pointer-events-none absolute right-8 z-20 -translate-y-1/2 rounded-md bg-surface-inverse px-2 py-1 text-xs whitespace-nowrap text-fg-inverse shadow-lg"
			style="top: {bubbleY}px"
		>
			{monthLabel(bubbleKey)}
		</div>
	{/if}
{/if}
