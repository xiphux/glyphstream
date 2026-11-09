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

	The open body lives in FeatureTogglesPanel and loads on first open: it's the
	chat route's only user of bits-ui's Switch and Tooltip, and the popover stays
	closed on almost every page view. Hovering, focusing or pressing the trigger
	starts the fetch, and the popover doesn't open until it has landed. Opening
	an empty shell and filling it later is NOT equivalent: the trigger sits at the
	bottom of the viewport, so an empty Content measures as fitting below it, gets
	placed there, and is clamped by `--bits-popover-content-available-height` to
	the sliver left — which keeps it from ever growing enough to flip, leaving the
	list stuck mostly off-screen.
-->
<script lang="ts">
	import type { Component, ComponentProps } from 'svelte';
	import { Popover } from 'bits-ui';
	import { Sliders } from '@lucide/svelte';
	import {
		featureCategoryAppliesToModelKind,
		isCategorySealedByPrivate,
		type FeatureCategory,
		type FeatureCategoryEntry,
		type ModelKind,
	} from '#lib/types/api.js';

	interface Props {
		disabledFeatures: readonly FeatureCategory[];
		/**
		 * Merged list of built-in + connected-MCP-server categories, assembled
		 * server-side and passed in by the parent. Layout-level data so first
		 * paint already has the right toggle set.
		 */
		categories: readonly FeatureCategoryEntry[];
		/**
		 * Whether this is a "Private chat". When true, the categories the private
		 * seal forces off (personalization, web, prompt-enhancement, every MCP
		 * server) render as off + locked — the seal is enforced server-side
		 * regardless, so showing them toggleable-on would be a lie. code_interpreter
		 * and skills stay interactive.
		 */
		private?: boolean;
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
		private: isPrivate = false,
	}: Props = $props();

	/** A row the private seal locks off — shown but not toggleable. */
	function isSealed(category: FeatureCategory): boolean {
		return isPrivate && isCategorySealedByPrivate(category);
	}

	/** The state the switch should DISPLAY: a sealed row always reads off,
	 *  regardless of the (irrelevant) stored disabledFeatures. */
	function displayEnabled(category: FeatureCategory): boolean {
		return !isSealed(category) && isEnabled(category);
	}

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

	// True when any *visible* category reads off — used to indicate the toggle is
	// in a non-default state, since the closed popover hides the actual state from
	// the user otherwise. Scoped to visible categories so the dot never points at a
	// hidden toggle (e.g. `web` off on an image model), and using the DISPLAYED
	// state so a private chat's sealed-off rows light the dot too.
	const anyDisabled = $derived(visibleCategories.some((c) => !displayEnabled(c.id)));

	type PanelProps = ComponentProps<typeof import('./FeatureTogglesPanel.svelte').default>;
	// One shared fetch for the trigger's prefetch and the open below.
	let panelLoad: Promise<void> | null = null;
	let Panel = $state<Component<PanelProps> | null>(null);
	// A failed fetch (offline, or a tab that outlived a redeploy and its hashed
	// chunk) is forgotten rather than cached, so the next hover or press retries
	// instead of the menu never opening again until a reload.
	const loadPanel = () =>
		(panelLoad ??= import('./FeatureTogglesPanel.svelte').then(
			(m) => {
				Panel = m.default;
			},
			(err: unknown) => {
				panelLoad = null;
				console.warn('Failed to load the feature toggles panel', err);
			},
		));
	const prefetchPanel = () => void loadPanel();

	// Opening waits for the panel (see the header comment); closing is immediate.
	let open = $state(false);
	function setOpen(next: boolean) {
		if (!next) open = false;
		else if (Panel) open = true;
		// A failed load resolves too; opening then would show an empty shell.
		else
			void loadPanel().then(() => {
				if (Panel) open = true;
			});
	}
</script>

<!-- No applicable toggles for this model (e.g. an embedding model, or a media
     model whose enhancer category isn't configured) → hide the whole control
     rather than open an empty popover. -->
{#if visibleCategories.length > 0}
	<Popover.Root bind:open={() => open, setOpen}>
		<Popover.Trigger
			{disabled}
			onpointerenter={prefetchPanel}
			onpointerdown={prefetchPanel}
			onfocus={prefetchPanel}
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
				class="z-overlay flex max-h-[min(70vh,var(--bits-popover-content-available-height))] w-[min(320px,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-lg border border-border surface-glass gs-pop shadow-lg"
			>
				{#if Panel}
					<Panel categories={visibleCategories} {isSealed} {displayEnabled} onToggle={toggle} />
				{/if}
			</Popover.Content>
		</Popover.Portal>
	</Popover.Root>
{/if}
