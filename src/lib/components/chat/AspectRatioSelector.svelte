<!--
	Shape picker for image / video models that advertise `aspect_ratios`
	(openai-api-bridge; see its docs/aspect-ratios.md). Sits in the composer
	action row beside the model picker, because the shape is part of composing a
	prompt rather than a setting you go elsewhere to change.

	The whole menu is DATA — the ratios come off the model row, never from a
	table here. So the icon is drawn from the two numbers in the value rather
	than picked from a set of per-ratio glyphs: a workflow offering something
	unusual (a third-party resolution node's "5:7 (Balanced Portrait)") renders
	correctly with nothing in this file that knows it exists, and `label` is only
	ever decoration.

	Hand-rolled option buttons rather than a bits-ui ToggleGroup / Select: the
	chat route's initial bundle is budgeted (tests/e2e/bundle-budget.spec.ts) and
	`Popover` is the one primitive already in this chunk via FeatureTogglesMenu,
	so this adds markup and no library.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { Popover } from 'bits-ui';
	import { ChevronDown } from '@lucide/svelte';
	import type { AspectRatioOption } from '$lib/types/api';
	import { nearestOffered, parseRatio, readStickyRatio, writeStickyRatio } from '$lib/aspect-ratio';

	interface Props {
		/** Ratios to offer — the union across the selected models, in render order. */
		options: AspectRatioOption[];
		/** What the target model does when a request names no ratio, used as the
		 *  opening selection before the user has ever picked one. */
		defaultValue?: string;
		/**
		 * A shape to open on regardless of the remembered preference — set when
		 * regenerating an existing image, so the re-run reproduces its framing.
		 *
		 * Bindable, and CLEARED here the moment the user picks: it is a one-shot
		 * intent, not a mode. It has to retire in the parent's state rather than in
		 * this component's, because this component unmounts whenever no selected
		 * model offers ratios — a local "already picked" flag resets on the remount
		 * and the stale seed would win again, silently reverting a choice the user
		 * had already made.
		 *
		 * Never rewrites the stored preference: reproducing one image is not a
		 * change of what they usually want.
		 */
		seed?: string | null;
		/** The ratio to send for this turn. Owned here and reported upward, so
		 *  both composers get the remembered-preference behaviour for free. */
		value: string | null;
		disabled?: boolean;
	}

	let {
		options,
		defaultValue,
		seed = $bindable(null),
		value = $bindable(),
		disabled = false,
	}: Props = $props();

	let open = $state(false);

	/**
	 * The user's last deliberate pick. Loaded in `onMount` rather than at init
	 * depth: init also runs during SSR, where `localStorage` doesn't exist, and
	 * a value appearing only on the client would be a hydration mismatch.
	 */
	let preference = $state<string | null>(null);
	onMount(() => {
		preference = readStickyRatio();
	});

	/**
	 * Resolve the preference against what's actually on offer, so the control
	 * shows what the user will GET rather than what it happens to be holding.
	 * Switching to a model with a different menu must not leave a value
	 * highlighted that the list no longer contains.
	 *
	 * Falls back to the model's own default, then to the first option, so the
	 * control is never in a blank state while it's visible at all.
	 */
	$effect(() => {
		const wanted = seed ?? preference;
		const resolved =
			nearestOffered(wanted, options) ??
			nearestOffered(defaultValue ?? null, options) ??
			options[0] ??
			null;
		value = resolved?.value ?? null;
	});

	function pick(next: string) {
		// Retire the one-shot seed in the PARENT's state, so it can't outlive this
		// component and override the pick after a remount.
		seed = null;
		// Written on the PICK, not on send: see writeStickyRatio.
		preference = next;
		writeStickyRatio(next);
		open = false;
	}

	const selected = $derived(options.find((o) => o.value === value) ?? null);

	/**
	 * Box dimensions for a ratio's glyph, inside a fixed square. The wider side
	 * fills the box and the other is scaled down, so the row of options reads as
	 * a set of shapes at a constant scale rather than a set of equal-area boxes.
	 */
	function glyph(ratioValue: string, box: number): { w: number; h: number } {
		const r = parseRatio(ratioValue);
		if (r === null) return { w: box, h: box };
		return r >= 1 ? { w: box, h: box / r } : { w: box * r, h: box };
	}
</script>

{#snippet shape(ratioValue: string, box: number)}
	{@const g = glyph(ratioValue, box)}
	<svg
		width={box}
		height={box}
		viewBox="0 0 {box} {box}"
		aria-hidden="true"
		class="shrink-0 overflow-visible"
	>
		<rect
			x={(box - g.w) / 2}
			y={(box - g.h) / 2}
			width={g.w}
			height={g.h}
			rx="1.5"
			fill="none"
			stroke="currentColor"
			stroke-width="1.5"
		/>
	</svg>
{/snippet}

<Popover.Root bind:open>
	<Popover.Trigger
		{disabled}
		aria-label={selected ? `Aspect ratio: ${selected.label ?? selected.value}` : 'Aspect ratio'}
		title="Aspect ratio"
		class="group inline-flex shrink-0 items-center gap-1 rounded-md border-0 bg-transparent px-2 py-1 text-xs text-fg-muted transition hover:bg-surface-raised hover:text-fg-secondary disabled:opacity-30"
	>
		{@render shape(selected?.value ?? '1:1', 13)}
		<span class="tabular-nums">{selected?.value ?? 'Shape'}</span>
		<ChevronDown size={12} class="opacity-60" />
	</Popover.Trigger>
	<Popover.Portal>
		<Popover.Content
			sideOffset={6}
			align="start"
			avoidCollisions
			collisionPadding={{ top: 60, right: 12, bottom: 12, left: 12 }}
			onOpenAutoFocus={(e) => e.preventDefault()}
			class="surface-glass gs-pop z-overlay w-[min(260px,calc(100vw-1.5rem))] overflow-hidden rounded-lg border border-border shadow-lg"
		>
			<div class="px-3 pb-1.5 pt-3 text-xs font-medium uppercase tracking-wide text-fg-muted">
				Aspect ratio
			</div>
			<div class="grid grid-cols-2 gap-1 p-2 pt-0">
				{#each options as option (option.value)}
					{@const isSelected = option.value === value}
					<button
						type="button"
						aria-pressed={isSelected}
						onclick={() => pick(option.value)}
						class={[
							'flex items-center gap-2 rounded-md border px-2 py-1.5 text-left text-xs transition',
							isSelected
								? 'border-accent bg-accent/10 text-accent'
								: 'border-transparent text-fg-secondary hover:border-border hover:bg-surface-sunken',
						]}
					>
						{@render shape(option.value, 16)}
						<span class="min-w-0">
							<span class="block tabular-nums">{option.value}</span>
							{#if option.label}
								<!-- Decoration only: absent for a ratio whose upstream gave it
								     no name, and never a placeholder in that case. -->
								<span class="block truncate text-[10px] text-fg-muted">{option.label}</span>
							{/if}
						</span>
					</button>
				{/each}
			</div>
		</Popover.Content>
	</Popover.Portal>
</Popover.Root>
