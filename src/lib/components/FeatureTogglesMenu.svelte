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

	Each row shows just the toggle name to keep the popover short (it grows
	with built-ins + every connected MCP server); the help text lives in an
	(i) hover/focus tooltip, and the list scrolls within the viewport rather
	than clipping off the top.
-->
<script lang="ts">
	import { Popover, Switch, Tooltip } from 'bits-ui';
	import { Sliders, Info } from '@lucide/svelte';
	import {
		featureCategoryAppliesToModelKind,
		type FeatureCategory,
		type FeatureCategoryEntry,
		type ModelKind,
	} from '$lib/types/api';

	interface Props {
		disabledFeatures: readonly FeatureCategory[];
		/**
		 * Merged list of built-in + connected-MCP-server categories, assembled
		 * server-side and passed in by the parent. Layout-level data so first
		 * paint already has the right toggle set.
		 */
		categories: readonly FeatureCategoryEntry[];
		/**
		 * The active model's kind, used to hide toggles that don't apply to it.
		 * The prompt-enhancement categories are kind-scoped — `image_prompt_enhancement`
		 * to image, `video_prompt_enhancement` to video; every other category is a
		 * tool-call / system-context feature only a chat model can reach. So an
		 * image model shows just the image enhancer, a video model just the video
		 * enhancer, a chat model everything else, and an embedding model nothing
		 * (see `featureCategoryAppliesToModelKind`) — when nothing applies the whole
		 * trigger is hidden. Null/undefined (unknown) shows everything, so a parent
		 * that can't supply it doesn't hide anything.
		 */
		modelKind?: ModelKind | null;
		onChange: (next: FeatureCategory[]) => void;
		disabled?: boolean;
	}

	let {
		disabledFeatures,
		categories,
		modelKind = null,
		onChange,
		disabled = false,
	}: Props = $props();

	// Drop category toggles that don't apply to the current model (image models
	// keep only the image enhancer, video models only the video enhancer; chat
	// models drop both enhancers; embedding models keep nothing). An unknown kind
	// keeps everything — the safe default.
	const visibleCategories = $derived(
		categories.filter((c) => featureCategoryAppliesToModelKind(c.id, modelKind)),
	);

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

	// True when any *visible* category is disabled — used to indicate the toggle
	// is in a non-default state, since the closed popover hides the actual state
	// from the user otherwise. Scoped to visible categories so the dot never
	// points at a hidden toggle (e.g. `web` off on an image model).
	const anyDisabled = $derived(visibleCategories.some((c) => !isEnabled(c.id)));
</script>

<!-- No applicable toggles for this model (e.g. an embedding model, or a media
     model whose enhancer category isn't configured) → hide the whole control
     rather than open an empty popover. -->
{#if visibleCategories.length > 0}
	<Popover.Root>
		<Popover.Trigger
			{disabled}
			aria-label="Feature toggles"
			title={anyDisabled ? 'Feature toggles (some features off)' : 'Feature toggles'}
			class="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-fg-muted transition hover:bg-surface-raised hover:text-fg-secondary disabled:opacity-30"
		>
			<Sliders size={18} strokeWidth={2.25} />
			{#if anyDisabled}
				<!-- Small dot in the corner so the closed-state user knows a
			     toggle is off without having to open the popover. -->
				<span
					class="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-warning ring-2 ring-surface-panel"
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
				onOpenAutoFocus={(e) => e.preventDefault()}
				class="z-50 flex max-h-[min(70vh,var(--bits-popover-content-available-height))] w-[min(320px,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-lg border border-border surface-glass gs-pop shadow-lg"
			>
				<Tooltip.Provider delayDuration={150} disableHoverableContent>
					<div
						class="shrink-0 px-3 pb-1.5 pt-3 text-xs font-medium uppercase tracking-wide text-fg-muted"
					>
						This conversation
					</div>
					<!-- Scrolls instead of clipping when the list outgrows the viewport
				     (many built-ins + connected MCP servers). -->
					<div class="flex flex-col gap-0.5 overflow-y-auto overscroll-contain px-2 pb-2">
						{#each visibleCategories as meta (meta.id)}
							{@const enabled = isEnabled(meta.id)}
							<!-- A <label> so a tap anywhere on the row toggles the switch — a
						     much bigger touch target than the switch alone (matters on
						     mobile). The Switch is FIRST in DOM so it's the label's
						     forwarded control; `order-last ml-auto` puts it back on the
						     right. The (i) tooltip trigger sits AFTER it in DOM, so a row
						     tap forwards to the switch, never the info button. -->
							<label
								class="flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 transition hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
							>
								<Switch.Root
									checked={enabled}
									onCheckedChange={(checked) => toggle(meta.id, checked)}
									aria-label={meta.label}
									class="relative order-last ml-auto inline-flex h-5 w-9 shrink-0 items-center rounded-full transition data-[state=checked]:bg-surface-inverse data-[state=unchecked]:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface-panel"
								>
									<Switch.Thumb
										class="block h-4 w-4 translate-x-0.5 rounded-full bg-surface-panel shadow-sm transition data-[state=checked]:translate-x-[1.125rem]"
									/>
								</Switch.Root>
								<span class="text-sm font-medium text-fg">{meta.label}</span>
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
											class="z-[60] max-w-[16rem] rounded-md border border-border surface-glass gs-pop px-2.5 py-1.5 text-xs leading-snug text-fg-secondary shadow-lg"
										>
											{meta.description}
										</Tooltip.Content>
									</Tooltip.Portal>
								</Tooltip.Root>
							</label>
						{/each}
					</div>
				</Tooltip.Provider>
			</Popover.Content>
		</Popover.Portal>
	</Popover.Root>
{/if}
