<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { Popover } from 'bits-ui';
	import { Check, ChevronDown, Minus, Plus, Search, Star, Layers } from '@lucide/svelte';
	import type { CompareSelection } from '$lib/fanout';
	import type { CustomModel, ModelEntry, ModelKind } from '$lib/types/api';

	interface Props {
		models: ModelEntry[];
		/**
		 * Optional saved presets. Rendered in their own "Your presets" group
		 * at the top of the unfiltered view. Each preset's selected value is
		 * `custom::{customModelId}` so the consumer can branch on the prefix.
		 */
		customModels?: CustomModel[];
		filterKinds?: readonly ModelKind[];
		value?: string;
		onChange?: (id: string) => void;
		disabled?: boolean;
		/**
		 * "Inline" variant — compact trigger button styled to blend into a
		 * composer box. Default is a full-width form-input shaped trigger.
		 */
		inline?: boolean;
		/**
		 * Picker-shape model ids the user has favorited. When non-empty, a
		 * "Favorites" group appears at the top of the unfiltered view; any
		 * id that doesn't resolve to a visible picker item is silently
		 * skipped (deleted preset, removed endpoint). Favorited models also
		 * still appear in their native group below — same item in two
		 * places, like a starred file in both "Starred" and its folder.
		 */
		favoritedIds?: readonly string[];
		/**
		 * Toggle handler for the star button on each row. When provided,
		 * each row renders a star icon (filled when favorited). When
		 * omitted, no star is rendered — the picker degrades to its
		 * pre-favorites behavior. The handler receives the row's picker
		 * value (`endpointId::upstreamId` or `custom::id`); the parent
		 * is responsible for persisting + invalidating data.
		 */
		onToggleFavorite?: (id: string) => void;
		/**
		 * Enable multi-model "compare" mode — a toggle in the dropdown header
		 * that flips rows from single-select to add-to-comparison. Off by
		 * default, so the settings/per-turn pickers are unaffected. Only base
		 * chat models are compare-eligible in this cut (no presets, no
		 * image/video); the rest are hidden while comparing.
		 */
		allowCompare?: boolean;
		/** The compare "cart": model id → count. Bindable so the consumer can
		 *  read it (to drive a fan-out) and reset it. */
		compareSelections?: CompareSelection[];
		/** Whether compare mode is active. Bindable so the consumer can reflect
		 *  it (e.g. relabel the Send button) and force it off. */
		compareMode?: boolean;
	}

	let {
		models,
		customModels = [],
		filterKinds,
		value = $bindable(''),
		onChange,
		disabled = false,
		inline = false,
		favoritedIds = [],
		onToggleFavorite,
		allowCompare = false,
		compareSelections = $bindable([]),
		compareMode = $bindable(false),
	}: Props = $props();

	// Kinds eligible for a comparison. A comparison must be single-modality
	// (you can't compare a chat reply with an image), so once the first model
	// is chosen the list locks to its kind.
	const COMPARE_KINDS: readonly ModelKind[] = ['chat', 'image', 'video'];
	const compareKind = $derived(
		compareSelections.length > 0
			? models.find((m) => m.id === compareSelections[0].modelId)?.kind
			: undefined,
	);

	function compareCountOf(modelId: string): number {
		return compareSelections.find((s) => s.modelId === modelId)?.count ?? 0;
	}
	function addCompare(modelId: string) {
		const existing = compareSelections.find((s) => s.modelId === modelId);
		compareSelections = existing
			? compareSelections.map((s) => (s.modelId === modelId ? { ...s, count: s.count + 1 } : s))
			: [...compareSelections, { modelId, count: 1 }];
	}
	function decCompare(modelId: string) {
		compareSelections = compareSelections.flatMap((s) =>
			s.modelId !== modelId ? [s] : s.count > 1 ? [{ ...s, count: s.count - 1 }] : [],
		);
	}
	const compareTotal = $derived(compareSelections.reduce((n, s) => n + s.count, 0));
	// Display name for a model id, for the compare summary chips.
	function modelLabel(modelId: string): string {
		return models.find((m) => m.id === modelId)?.displayName ?? modelId;
	}

	// Flip compare mode: seed the cart from the current single selection (so
	// the model you were on is already in the comparison), clear it on exit.
	function toggleCompareMode() {
		compareMode = !compareMode;
		if (compareMode) {
			const cur = models.find((m) => m.id === value);
			compareSelections =
				cur && COMPARE_KINDS.includes(cur.kind) ? [{ modelId: cur.id, count: 1 }] : [];
		} else {
			compareSelections = [];
		}
	}

	function kindEmoji(kind: ModelKind): string {
		switch (kind) {
			case 'image':
				return '📷';
			case 'video':
				return '📹';
			case 'embedding':
				return '🔢';
			default:
				return '';
		}
	}

	/**
	 * Internal flat item shape. We always work in flat lists internally so
	 * search filtering + keyboard nav stay simple; group headers are just a
	 * separate decoration on the unfiltered render path.
	 */
	interface PickerItem {
		value: string;
		label: string;
		sublabel: string;
		kind: ModelKind;
		isCustom: boolean;
		groupKey: string;
		groupLabel: string;
		/** Pre-lowercased haystack for fast search filtering. */
		searchText: string;
	}

	const visible = $derived.by(() => {
		if (!filterKinds) return models;
		const set = new Set(filterKinds);
		return models.filter((m) => set.has(m.kind));
	});

	/**
	 * Build the flat item list, in display order:
	 *   1. Favorites (looked up against the other groups; same row appears
	 *      twice — once here, once in its native group below).
	 *   2. Custom presets (filtered to ones whose base model is visible).
	 *   3. Base models grouped by endpointId, sorted alphabetically per group.
	 * Each item carries enough context (group label, sublabel, search haystack)
	 * to render in either grouped or flat mode without re-deriving.
	 */
	const items = $derived.by<PickerItem[]>(() => {
		const baseById = new Map(models.map((m) => [m.id, m] as const));
		const out: PickerItem[] = [];

		// Custom presets — built into a separate Map so we can also serve
		// the Favorites lookup (custom and base models share an id namespace
		// in `favoritedIds`).
		const presets: PickerItem[] = [];
		for (const cm of customModels) {
			const base = baseById.get(`${cm.baseEndpointId}::${cm.baseModelId}`);
			if (!base) continue;
			if (filterKinds && !(filterKinds as readonly ModelKind[]).includes(base.kind)) {
				continue;
			}
			presets.push({
				value: `custom::${cm.id}`,
				label: cm.name,
				sublabel: base.displayName,
				kind: base.kind,
				isCustom: true,
				groupKey: '__custom',
				groupLabel: 'Your presets',
				searchText: `${cm.name} ${base.displayName} ${cm.description ?? ''}`.toLowerCase(),
			});
		}

		// Base models, grouped by m.groupKey (server-side policy: usually the
		// endpoint id, but when an endpoint sets group_by="owned_by" in
		// config.toml each underlying provider becomes its own group).
		// Within a group, show owner sublabels only when there are multiple
		// distinct owners — keeps labels tidy and avoids redundant "·
		// openrouter" tags inside an "OpenRouter" group.
		const byGroup = new Map<string, ModelEntry[]>();
		for (const m of visible) {
			const list = byGroup.get(m.groupKey);
			if (list) list.push(m);
			else byGroup.set(m.groupKey, [m]);
		}

		const baseItems: PickerItem[] = [];
		for (const [, group] of byGroup) {
			const distinctOwners = new Set(group.map((m) => m.ownedBy).filter((o): o is string => !!o));
			const showOwner = distinctOwners.size > 1;
			const sortedGroup = [...group].sort((a, b) => a.displayName.localeCompare(b.displayName));
			for (const m of sortedGroup) {
				baseItems.push({
					value: m.id,
					label: m.displayName,
					sublabel: showOwner && m.ownedBy ? m.ownedBy : '',
					kind: m.kind,
					isCustom: false,
					groupKey: m.groupKey,
					groupLabel: m.group,
					searchText:
						`${m.displayName} ${m.ownedBy ?? ''} ${m.upstreamId} ${m.endpointId} ${m.group}`.toLowerCase(),
				});
			}
		}

		// Favorites group: look up each favorited id against the items we
		// already built, drop unknowns, and stamp them as belonging to the
		// "Favorites" pseudo-group. The PickerItem objects are clones so
		// each rendered row has a unique reference — important because
		// `indexOf` below uses identity, and a shared object would make
		// the highlight in the Favorites row also highlight the duplicate
		// row in the native group below.
		if (favoritedIds.length > 0) {
			const lookup = new Map<string, PickerItem>();
			for (const p of presets) lookup.set(p.value, p);
			for (const b of baseItems) lookup.set(b.value, b);
			for (const id of favoritedIds) {
				const item = lookup.get(id);
				if (!item) continue;
				out.push({
					...item,
					groupKey: '__favorites',
					groupLabel: 'Favorites',
				});
			}
		}

		out.push(...presets);
		out.push(...baseItems);
		return out;
	});

	// Set form of favoritedIds for O(1) per-row lookup in the render loop.
	const favoritedSet = $derived(new Set(favoritedIds));

	let open = $state(false);
	let search = $state('');
	let highlightedIndex = $state(0);
	let listEl = $state<HTMLElement | null>(null);
	let searchInputEl = $state<HTMLInputElement | null>(null);

	const filteredItems = $derived.by(() => {
		// Compare mode only adds base models of an eligible kind (no presets),
		// and once a kind is chosen it locks to that single modality — hide the
		// rest so the list reflects what's addable.
		const base = compareMode
			? items.filter(
					(it) =>
						!it.isCustom &&
						COMPARE_KINDS.includes(it.kind) &&
						(!compareKind || it.kind === compareKind),
				)
			: items;
		const q = search.trim().toLowerCase();
		if (!q) return base;
		// Tokenize on whitespace so multi-word queries like "openai gpt"
		// match anywhere in the haystack regardless of order. The favorites
		// group is hidden when searching — every favorited row also exists
		// in its native group, and duplicating matches in the flat-search
		// view confuses more than it helps.
		const tokens = q.split(/\s+/);
		return base.filter(
			(item) => item.groupKey !== '__favorites' && tokens.every((t) => item.searchText.includes(t)),
		);
	});

	/** Currently selected item (or undefined if value isn't in `items`). */
	const selected = $derived(items.find((i) => i.value === value));

	/**
	 * Trigger label for the collapsed view. Strips any `owner/` prefix
	 * (very common with HuggingFace-shaped ids like `meta-llama/Llama-3-70b`)
	 * since the username eats space we'd rather give to the actual model
	 * name. The full owner/model is still shown in the open dropdown row.
	 * Custom presets get their full user-given name preserved.
	 */
	function stripOwner(label: string): string {
		const slash = label.lastIndexOf('/');
		return slash >= 0 ? label.slice(slash + 1) : label;
	}
	const triggerLabel = $derived.by(() => {
		// A comparison of 2+ reads as "Comparing N models" (or "N variations"
		// for image, where the same model may be sampled multiple times).
		// Exactly one isn't a comparison — show that model's name (it collapses
		// back to a normal single selection when the picker closes).
		if (compareMode && compareTotal >= 2) {
			// "variations" for media (image/video), where the same model may be
			// sampled multiple times; "models" for a chat comparison.
			return `Comparing ${compareTotal} ${compareKind === 'chat' ? 'models' : 'variations'}`;
		}
		if (compareMode && compareTotal === 1) {
			const m = models.find((x) => x.id === compareSelections[0].modelId);
			if (m) return stripOwner(m.displayName);
		}
		if (!selected) return 'Choose a model…';
		if (selected.isCustom) return selected.label;
		return stripOwner(selected.label);
	});

	// On open, jump highlight to the currently-selected row (or the first one
	// if nothing matches). On filter change, snap highlight back to the top
	// — otherwise the highlight could land out-of-bounds in the new list.
	$effect(() => {
		if (open) {
			const idx = filteredItems.findIndex((i) => i.value === value);
			highlightedIndex = idx >= 0 ? idx : 0;
		}
	});
	$effect(() => {
		void search;
		highlightedIndex = 0;
	});

	// On close: reset search, and collapse a 0-or-1-model comparison back to
	// single-select — a "comparison" of one model is just a normal selection,
	// so promote it to `value` and exit compare mode (no point keeping the
	// split-view machinery armed for one). untrack keeps this effect's only
	// dependency `open`, so editing the cart while open doesn't re-fire it.
	$effect(() => {
		if (open) return;
		search = '';
		untrack(() => {
			if (compareMode && compareTotal <= 1) {
				if (compareTotal === 1) {
					value = compareSelections[0].modelId;
					onChange?.(value);
				}
				compareMode = false;
				compareSelections = [];
			}
		});
	});

	async function selectItem(item: PickerItem) {
		value = item.value;
		onChange?.(item.value);
		open = false;
		await tick();
	}

	function moveHighlight(delta: number) {
		if (filteredItems.length === 0) return;
		const next = (highlightedIndex + delta + filteredItems.length) % filteredItems.length;
		highlightedIndex = next;
		// Scroll the new highlight into view if it's outside the visible
		// region. `block: 'nearest'` keeps the user in the same scroll
		// position when the highlight is already on screen.
		queueMicrotask(() => {
			const el = listEl?.querySelector<HTMLElement>(`[data-picker-index="${next}"]`);
			el?.scrollIntoView({ block: 'nearest' });
		});
	}

	function onSearchKeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			moveHighlight(1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			moveHighlight(-1);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			const item = filteredItems[highlightedIndex];
			if (!item) return;
			if (compareMode) addCompare(item.value);
			else void selectItem(item);
		} else if (e.key === 'Home') {
			e.preventDefault();
			highlightedIndex = 0;
		} else if (e.key === 'End') {
			e.preventDefault();
			highlightedIndex = Math.max(0, filteredItems.length - 1);
		}
		// Escape is handled by Popover natively.
	}

	// `groupedRender` is the structure we walk in the template: when
	// searching we collapse to a single unlabeled group so results are tight;
	// when not searching we show real group headers.
	const groupedRender = $derived.by(() => {
		if (search.trim()) {
			return [{ key: '__flat', label: '', items: filteredItems }];
		}
		const out: { key: string; label: string; items: PickerItem[] }[] = [];
		let current: { key: string; label: string; items: PickerItem[] } | null = null;
		for (const it of filteredItems) {
			if (!current || current.key !== it.groupKey) {
				current = { key: it.groupKey, label: it.groupLabel, items: [] };
				out.push(current);
			}
			current.items.push(it);
		}
		return out;
	});

	// Index lookup for rendering: the highlight applies to the flat
	// filteredItems list, so each rendered row needs to know its index.
	// Using `filteredItems.indexOf` per row would make the picker render
	// O(N²) over the model count; the Map keeps it O(N). Each row's
	// PickerItem is unique by identity (the Favorites clones above ensure
	// that), so identity-keyed lookup works.
	const indexByItem = $derived.by(() => {
		const map = new Map<PickerItem, number>();
		for (let i = 0; i < filteredItems.length; i++) {
			map.set(filteredItems[i], i);
		}
		return map;
	});
	function indexOf(item: PickerItem): number {
		return indexByItem.get(item) ?? -1;
	}
</script>

<Popover.Root bind:open>
	<div class={inline ? 'group/preview relative inline-flex' : 'group/preview relative w-full'}>
		<Popover.Trigger
			{disabled}
			class={inline
				? 'group inline-flex max-w-[200px] items-center gap-1 rounded-md border-0 bg-transparent px-2 py-1 text-xs text-fg-muted transition hover:bg-surface-raised focus:outline-none focus-visible:ring-1 focus-visible:ring-border-focus disabled:opacity-50'
				: 'group flex w-full items-center justify-between gap-2 rounded-md border border-border bg-surface-panel px-3 py-2 text-sm shadow-sm transition hover:border-border-strong focus:border-border-focus focus:outline-none disabled:opacity-50'}
			aria-label="Select model"
		>
			<span class="truncate">{triggerLabel}</span>
			<ChevronDown
				size={inline ? 12 : 14}
				strokeWidth={2.25}
				class="shrink-0 opacity-60 transition group-hover:opacity-100"
			/>
		</Popover.Trigger>
		{#if !open && compareMode && compareTotal >= 2}
			<!-- At-a-glance preview of the comparison cart on hover, so you don't
			     have to open the picker to recall what's selected. -->
			<div
				class="pointer-events-none absolute bottom-full right-0 z-50 mb-1.5 hidden group-hover/preview:block"
			>
				<div
					class="min-w-[11rem] max-w-[18rem] rounded-lg border border-border surface-glass gs-pop px-2.5 py-2 text-xs shadow-lg"
				>
					<div class="mb-1 text-[10px] font-medium uppercase tracking-wide text-fg-muted">
						Comparing
					</div>
					<ul class="space-y-0.5">
						{#each compareSelections as sel (sel.modelId)}
							<li class="flex items-center justify-between gap-3">
								<span class="truncate text-fg">{modelLabel(sel.modelId)}</span>
								<span class="shrink-0 tabular-nums text-fg-muted">×{sel.count}</span>
							</li>
						{/each}
					</ul>
				</div>
			</div>
		{/if}
	</div>
	<Popover.Portal>
		<Popover.Content
			sideOffset={6}
			align="end"
			avoidCollisions
			collisionPadding={{ top: 60, right: 12, bottom: 12, left: 12 }}
			onOpenAutoFocus={(e) => {
				// Skip auto-focus on touch devices. bits-ui's FocusScope would
				// otherwise pull focus to the search input on every open, and
				// on iOS that springs the on-screen keyboard — which then
				// races with Floating UI's sizing pass and leaves the inner
				// list in a state where touch-scroll attempts bubble out to
				// the (already-locked) page instead of scrolling the list.
				// On non-touch the auto-focus is still desirable; let it run.
				if (window.matchMedia?.('(pointer: coarse)').matches) {
					e.preventDefault();
				}
			}}
			class="z-50 flex w-[min(360px,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-lg border border-border surface-glass gs-pop shadow-lg max-h-[min(60vh,var(--bits-popover-content-available-height))]"
		>
			<!-- Search row. Auto-focuses on open via Popover's focus-trap on
				 pointer:fine devices; tap-to-focus on touch (see onOpenAutoFocus
				 above). -->
			<div class="flex items-center gap-2 border-b border-border px-3 py-2">
				<Search size={14} strokeWidth={2.25} class="opacity-50" />
				<input
					bind:this={searchInputEl}
					bind:value={search}
					type="text"
					placeholder="Search models…"
					autocomplete="off"
					autocorrect="off"
					spellcheck="false"
					onkeydown={onSearchKeydown}
					class="flex-1 border-0 bg-transparent text-base focus:outline-none sm:text-sm"
				/>
			</div>

			{#if allowCompare}
				<!-- Compare-mode controls. The toggle flips the list to
				     multi-select: clicking a row then adds it to the comparison
				     (popover stays open) instead of selecting + closing. -->
				<div class="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
					<button
						type="button"
						onclick={toggleCompareMode}
						aria-pressed={compareMode}
						title="Compare multiple models at once"
						class="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs transition {compareMode
							? 'bg-accent/15 text-accent'
							: 'text-fg-muted hover:bg-surface-raised'}"
					>
						<Layers size={13} strokeWidth={2.25} />
						Multiple
					</button>
					{#if compareMode}
						{#if compareSelections.length === 0}
							<span class="text-xs text-fg-muted">Click models below to compare them…</span>
						{:else}
							{#each compareSelections as sel (sel.modelId)}
								<span
									class="inline-flex items-center gap-1 rounded-full border border-border bg-surface-raised py-0.5 pl-2 pr-1 text-xs"
								>
									<span class="max-w-[9rem] truncate" title={modelLabel(sel.modelId)}>
										{modelLabel(sel.modelId)}
									</span>
									<span class="text-fg-muted">×{sel.count}</span>
									<button
										type="button"
										onclick={() => decCompare(sel.modelId)}
										aria-label="Remove one {modelLabel(sel.modelId)}"
										class="flex h-4 w-4 items-center justify-center rounded-full text-fg-muted transition hover:bg-surface-sunken hover:text-fg"
									>
										<Minus size={11} strokeWidth={2.5} />
									</button>
								</span>
							{/each}
						{/if}
					{/if}
				</div>
			{/if}

			<div bind:this={listEl} role="listbox" class="flex-1 overflow-y-auto overscroll-contain py-1">
				{#if filteredItems.length === 0}
					<p class="px-3 py-3 text-xs text-fg-muted">
						{items.length === 0 ? 'No models available.' : `No matches for "${search.trim()}"`}
					</p>
				{/if}

				{#each groupedRender as g (g.key)}
					{#if g.label}
						<div
							class="px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-fg-muted"
						>
							{g.label}
						</div>
					{/if}
					{#each g.items as item, i (`${g.key}:${item.value}:${i}`)}
						{@const idx = indexOf(item)}
						{@const isHighlighted = idx === highlightedIndex}
						{@const isSelected = item.value === value}
						{@const isFavorited = favoritedSet.has(item.value)}
						{@const compareCount = compareMode ? compareCountOf(item.value) : 0}
						<div
							class="group/row flex w-full items-center gap-2 px-3 py-1.5 text-sm transition {isHighlighted
								? 'bg-surface-raised'
								: ''}"
							onmouseenter={() => (highlightedIndex = idx)}
							role="presentation"
						>
							<button
								type="button"
								role="option"
								aria-selected={compareMode ? compareCount > 0 : isSelected}
								data-picker-index={idx}
								onclick={() => (compareMode ? addCompare(item.value) : selectItem(item))}
								class="flex min-w-0 flex-1 items-center gap-2 text-left"
							>
								<span class="min-w-0 flex-1 truncate">
									{#if item.isCustom}
										<span class="mr-1 opacity-60">⚙</span>
									{/if}
									{item.label}
									{#if item.sublabel}
										<span class="ml-1 text-xs text-fg-muted">· {item.sublabel}</span>
									{/if}
								</span>
								{#if item.kind !== 'chat' && item.kind !== 'embedding'}
									<span class="shrink-0 text-xs opacity-70">{kindEmoji(item.kind)}</span>
								{:else if item.kind === 'embedding'}
									<span class="shrink-0 text-xs opacity-70">{kindEmoji(item.kind)}</span>
								{/if}
								{#if compareMode}
									{#if compareCount > 0}
										<span class="shrink-0 text-xs font-medium text-accent tabular-nums"
											>×{compareCount}</span
										>
									{/if}
									<Plus size={14} strokeWidth={2.5} class="shrink-0 text-fg-muted" />
								{:else if isSelected}
									<Check size={14} strokeWidth={2.5} class="shrink-0 text-accent" />
								{/if}
							</button>
							{#if onToggleFavorite && !compareMode}
								<!--
									The star sits outside the select button so a click
									toggles favorite without also picking the model. It
									stays visible on hover or when already favorited;
									otherwise it fades to keep unfilled rows quiet —
									the picker is busy enough without a column of grey
									stars in every row. Hidden in compare mode to keep
									the add-to-comparison target unambiguous.
								-->
								<button
									type="button"
									onclick={(e) => {
										e.stopPropagation();
										onToggleFavorite?.(item.value);
									}}
									aria-label={isFavorited ? 'Unfavorite model' : 'Favorite model'}
									title={isFavorited ? 'Unfavorite' : 'Favorite'}
									class="shrink-0 rounded p-1 text-fg-subtle transition hover:bg-surface-sunken hover:text-amber-500 focus:opacity-100 focus-visible:opacity-100 {isFavorited
										? 'text-amber-500 opacity-100'
										: 'opacity-0 group-hover/row:opacity-100'}"
								>
									<Star size={14} strokeWidth={2.25} fill={isFavorited ? 'currentColor' : 'none'} />
								</button>
							{/if}
						</div>
					{/each}
				{/each}
			</div>
		</Popover.Content>
	</Popover.Portal>
</Popover.Root>
