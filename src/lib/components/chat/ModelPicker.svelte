<script lang="ts">
	import { tick } from 'svelte';
	import { Popover } from 'bits-ui';
	import { Check, ChevronDown, Search } from 'lucide-svelte';
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
	}

	let {
		models,
		customModels = [],
		filterKinds,
		value = $bindable(''),
		onChange,
		disabled = false,
		inline = false
	}: Props = $props();

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
	 *   1. Custom presets (filtered to ones whose base model is visible).
	 *   2. Base models grouped by endpointId, sorted alphabetically per group.
	 * Each item carries enough context (group label, sublabel, search haystack)
	 * to render in either grouped or flat mode without re-deriving.
	 */
	const items = $derived.by<PickerItem[]>(() => {
		const baseById = new Map(models.map((m) => [m.id, m] as const));
		const out: PickerItem[] = [];

		// Custom presets first.
		for (const cm of customModels) {
			const base = baseById.get(`${cm.baseEndpointId}::${cm.baseModelId}`);
			if (!base) continue;
			if (filterKinds && !(filterKinds as readonly ModelKind[]).includes(base.kind)) {
				continue;
			}
			out.push({
				value: `custom::${cm.id}`,
				label: cm.name,
				sublabel: base.displayName,
				kind: base.kind,
				isCustom: true,
				groupKey: '__custom',
				groupLabel: 'Your presets',
				searchText: `${cm.name} ${base.displayName} ${cm.description ?? ''}`.toLowerCase()
			});
		}

		// Base models, grouped by endpoint. Within an endpoint, prefix the
		// owner only when there are multiple distinct owners (matches the
		// pre-popover picker's behavior so labels stay tidy).
		const byEndpoint = new Map<string, ModelEntry[]>();
		for (const m of visible) {
			const list = byEndpoint.get(m.endpointId);
			if (list) list.push(m);
			else byEndpoint.set(m.endpointId, [m]);
		}

		for (const [endpointId, group] of byEndpoint) {
			const distinctOwners = new Set(
				group.map((m) => m.ownedBy).filter((o): o is string => !!o)
			);
			const showOwner = distinctOwners.size > 1;
			const sortedGroup = [...group].sort((a, b) =>
				a.displayName.localeCompare(b.displayName)
			);
			for (const m of sortedGroup) {
				out.push({
					value: m.id,
					label: m.displayName,
					sublabel: showOwner && m.ownedBy ? m.ownedBy : '',
					kind: m.kind,
					isCustom: false,
					groupKey: endpointId,
					groupLabel: endpointId,
					searchText:
						`${m.displayName} ${m.ownedBy ?? ''} ${m.upstreamId} ${endpointId}`.toLowerCase()
				});
			}
		}

		return out;
	});

	let open = $state(false);
	let search = $state('');
	let highlightedIndex = $state(0);
	let listEl = $state<HTMLElement | null>(null);
	let searchInputEl = $state<HTMLInputElement | null>(null);

	const filteredItems = $derived.by(() => {
		const q = search.trim().toLowerCase();
		if (!q) return items;
		// Tokenize on whitespace so multi-word queries like "openai gpt"
		// match anywhere in the haystack regardless of order.
		const tokens = q.split(/\s+/);
		return items.filter((item) => tokens.every((t) => item.searchText.includes(t)));
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
	const triggerLabel = $derived.by(() => {
		if (!selected) return 'Choose a model…';
		if (selected.isCustom) return selected.label;
		const slash = selected.label.lastIndexOf('/');
		return slash >= 0 ? selected.label.slice(slash + 1) : selected.label;
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

	// Reset search every time the popover closes so the next open starts
	// from a clean state.
	$effect(() => {
		if (!open) search = '';
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
			const el = listEl?.querySelector<HTMLElement>(
				`[data-picker-index="${next}"]`
			);
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
			if (item) void selectItem(item);
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
	// filteredItems list, so we map (groupedItem) → its index in that list.
	function indexOf(item: PickerItem): number {
		return filteredItems.indexOf(item);
	}
</script>

<Popover.Root bind:open>
	<Popover.Trigger
		{disabled}
		class={inline
			? 'group inline-flex max-w-[200px] items-center gap-1 rounded-md border-0 bg-transparent px-2 py-1 text-xs text-neutral-600 transition hover:bg-neutral-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-400 disabled:opacity-50 dark:text-neutral-400 dark:hover:bg-neutral-800'
			: 'group flex w-full items-center justify-between gap-2 rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm shadow-sm transition hover:border-neutral-300 focus:border-neutral-400 focus:outline-none disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:border-neutral-600'}
		aria-label="Select model"
	>
		<span class="truncate">{triggerLabel}</span>
		<ChevronDown
			size={inline ? 12 : 14}
			strokeWidth={2.25}
			class="shrink-0 opacity-60 transition group-hover:opacity-100"
		/>
	</Popover.Trigger>
	<Popover.Portal>
		<Popover.Content
			sideOffset={6}
			align="end"
			avoidCollisions
			collisionPadding={12}
			class="z-50 flex w-[min(360px,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-lg dark:border-neutral-700 dark:bg-neutral-900 max-h-[min(60vh,var(--bits-popover-content-available-height))]"
		>
			<!-- Search row. Auto-focuses on open via Popover's focus-trap. -->
			<div class="flex items-center gap-2 border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
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
					class="flex-1 border-0 bg-transparent text-sm focus:outline-none"
				/>
			</div>

			<div bind:this={listEl} role="listbox" class="flex-1 overflow-y-auto py-1">
				{#if filteredItems.length === 0}
					<p class="px-3 py-3 text-xs text-neutral-500">
						{items.length === 0
							? 'No models available.'
							: `No matches for "${search.trim()}"`}
					</p>
				{/if}

				{#each groupedRender as g (g.key)}
					{#if g.label}
						<div class="px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-neutral-500">
							{g.label}
						</div>
					{/if}
					{#each g.items as item (item.value)}
						{@const idx = indexOf(item)}
						{@const isHighlighted = idx === highlightedIndex}
						{@const isSelected = item.value === value}
						<button
							type="button"
							role="option"
							aria-selected={isSelected}
							data-picker-index={idx}
							onclick={() => selectItem(item)}
							onmouseenter={() => (highlightedIndex = idx)}
							class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition {isHighlighted
								? 'bg-neutral-100 dark:bg-neutral-800'
								: ''}"
						>
							<span class="flex-1 truncate">
								{#if item.isCustom}
									<span class="mr-1 opacity-60">⚙</span>
								{/if}
								{item.label}
								{#if item.sublabel}
									<span class="ml-1 text-xs text-neutral-500">· {item.sublabel}</span>
								{/if}
							</span>
							{#if item.kind !== 'chat' && item.kind !== 'embedding'}
								<span class="shrink-0 text-xs opacity-70">{kindEmoji(item.kind)}</span>
							{:else if item.kind === 'embedding'}
								<span class="shrink-0 text-xs opacity-70">{kindEmoji(item.kind)}</span>
							{/if}
							{#if isSelected}
								<Check size={14} strokeWidth={2.5} class="shrink-0 opacity-80" />
							{/if}
						</button>
					{/each}
				{/each}
			</div>
		</Popover.Content>
	</Popover.Portal>
</Popover.Root>
