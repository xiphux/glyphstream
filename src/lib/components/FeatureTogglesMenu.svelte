<!--
	Per-conversation feature opt-out menu. Sits next to the composer's
	+ (attach) button as a small popover trigger; clicking opens a list
	of switches, one per FEATURE_CATEGORIES entry.

	Pure presentation: owner supplies `disabledFeatures` + an `onChange`
	handler. The handler decides what "change" means — for the new-chat
	composer it's transient local state shipped with the next POST, for
	the existing-chat composer it's a fire-and-forget PATCH.

	Why categories instead of one switch per tool: a privacy-driven opt-
	out is a security boundary, not a UX grouping. Hiding web_search but
	leaving fetch_url reachable lets the model trivially compose around
	the gate (e.g. fetch_url-ing a search-engine URL directly). Both
	web-touching tools share the 'web' category so a single switch
	closes the whole egress path.
-->
<script lang="ts">
	import { Popover, Switch } from 'bits-ui';
	import { Sliders } from '@lucide/svelte';
	import {
		FEATURE_CATEGORIES,
		FEATURE_CATEGORY_LABELS,
		type FeatureCategory
	} from '$lib/types/api';

	interface Props {
		disabledFeatures: readonly FeatureCategory[];
		onChange: (next: FeatureCategory[]) => void;
		disabled?: boolean;
	}

	let { disabledFeatures, onChange, disabled = false }: Props = $props();

	function isEnabled(category: FeatureCategory): boolean {
		return !disabledFeatures.includes(category);
	}

	function toggle(category: FeatureCategory, enabled: boolean) {
		const next = enabled
			? disabledFeatures.filter((c) => c !== category)
			: disabledFeatures.includes(category)
				? [...disabledFeatures]
				: [...disabledFeatures, category];
		onChange(next);
	}

	// True when ANY category is disabled — used to indicate the toggle is
	// in a non-default state, since the closed popover hides the actual
	// state from the user otherwise.
	const anyDisabled = $derived(disabledFeatures.length > 0);
</script>

<Popover.Root>
	<Popover.Trigger
		{disabled}
		aria-label="Feature toggles"
		title={anyDisabled ? 'Feature toggles (some features off)' : 'Feature toggles'}
		class="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-700 disabled:opacity-30 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
	>
		<Sliders size={18} strokeWidth={2.25} />
		{#if anyDisabled}
			<!-- Small dot in the corner so the closed-state user knows a
			     toggle is off without having to open the popover. -->
			<span
				class="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-amber-500 ring-2 ring-white dark:ring-neutral-900"
				aria-hidden="true"
			></span>
		{/if}
	</Popover.Trigger>
	<Popover.Portal>
		<Popover.Content
			sideOffset={6}
			align="start"
			avoidCollisions
			collisionPadding={{ top: 60, right: 12, bottom: 12, left: 12 }}
			class="z-50 flex w-[min(320px,calc(100vw-1.5rem))] flex-col gap-2 rounded-lg border border-neutral-200 bg-white p-3 shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
		>
			<div class="text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
				This conversation
			</div>
			{#each FEATURE_CATEGORIES as category (category)}
				{@const meta = FEATURE_CATEGORY_LABELS[category]}
				{@const enabled = isEnabled(category)}
				<label class="flex cursor-pointer items-start gap-3 rounded-md p-2 transition hover:bg-neutral-50 dark:hover:bg-neutral-800/50">
					<div class="flex-1">
						<div class="text-sm font-medium text-neutral-900 dark:text-neutral-100">
							{meta.label}
						</div>
						<div class="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
							{meta.description}
						</div>
					</div>
					<Switch.Root
						checked={enabled}
						onCheckedChange={(checked) => toggle(category, checked)}
						aria-label={meta.label}
						class="relative mt-1 inline-flex h-5 w-9 shrink-0 items-center rounded-full transition data-[state=checked]:bg-neutral-900 data-[state=unchecked]:bg-neutral-300 dark:data-[state=checked]:bg-neutral-100 dark:data-[state=unchecked]:bg-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-neutral-900"
					>
						<Switch.Thumb
							class="block h-4 w-4 translate-x-0.5 rounded-full bg-white shadow-sm transition data-[state=checked]:translate-x-[1.125rem] dark:bg-neutral-900 dark:data-[state=checked]:bg-neutral-900"
						/>
					</Switch.Root>
				</label>
			{/each}
		</Popover.Content>
	</Popover.Portal>
</Popover.Root>
