<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { Popover, Switch } from 'bits-ui';
	import { ChevronLeft, Search, SlidersHorizontal, SquareCheck } from '@lucide/svelte';
	import MediaLightbox from '$lib/components/MediaLightbox.svelte';
	import { confirmDialog } from '$lib/confirm.svelte';
	import GalleryTimelineRail from '$lib/components/GalleryTimelineRail.svelte';
	import { type Granularity } from '$lib/gallery-date-buckets';
	import { buildLayoutSections, monthTicksFromLayout } from '$lib/gallery-layout';
	import { promptRunKey } from '$lib/gallery-stacks';
	import { GalleryFeed } from '$lib/gallery-feed.svelte';
	import { computeSectionWindows, type WindowConstants } from '$lib/gallery-window';
	import type {
		GalleryLayout,
		GalleryUnit,
		GalleryUnitsPage,
		MediaConversationRef,
		MediaListItem,
	} from '$lib/server/db/queries/media';

	let { data } = $props<{
		data: {
			mode: 'browse' | 'search';
			searchItems?: MediaListItem[];
			kind: 'image' | 'video' | null;
			model: string | null;
			modelFacets: { value: string; label: string; count: number }[];
			q: string | null;
		};
	}>();

	// Search is a relevance-ranked mode: date headers, timeline rail, and stacking
	// are all suspended; results come pre-ranked + cursorless from the server as a
	// flat MediaListItem list.
	const searching = $derived(!!data.q);

	// Viewer's UTC offset in minutes; every layout/units fetch passes it so the
	// day buckets match the local-time section headers. Browse is fetched
	// client-side on mount with this offset (never SSR'd — the server has no
	// viewer tz), so the buckets are local-correct from the first load.
	const tzOffset = () => -new Date().getTimezoneOffset();

	// A hung fetch must never strand the grid in a loading/placeholder state with
	// no recovery, so every gallery fetch is time-boxed with an AbortController
	// (the old cursor-pagination path used the same pattern). On timeout the fetch
	// rejects, the caller's catch/finally runs, and the range/reload becomes
	// retriable again.
	async function fetchWithTimeout(url: string, ms = 15_000): Promise<Response> {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), ms);
		try {
			return await fetch(url, { signal: ctrl.signal });
		} finally {
			clearTimeout(timer);
		}
	}

	// Two failure channels, kept distinct so a delete error can't masquerade as a
	// recoverable load error (and vice versa): `loadError` is for the browse
	// layout/units fetches — its banner offers Retry, which re-runs the load —
	// while `error` is for delete / lightbox failures, whose banner has no Retry
	// (there's nothing for a generic reload to re-attempt).
	let loadError = $state<string | null>(null);
	let error = $state<string | null>(null);
	let deletingId = $state<string | null>(null);

	// --- Browse feed (layout-driven virtualization) -------------------------
	// The server owns stacking + counts (see computeGalleryLayout / listGalleryUnits);
	// the feed reserves exact height from the per-day unit counts and streams thin
	// unit descriptors for the visible range. See $lib/gallery-feed.
	let stacking = $state(true);
	let granularity = $state<Granularity>('month');

	// The kind/model/stack/tz filter params shared by the layout + units fetches.
	// Built in one place so the two (which MUST agree for the unit offsets to line
	// up with the layout's reserved section heights) can't drift.
	function galleryFilterParams(): URLSearchParams {
		const p = new URLSearchParams();
		if (data.kind) p.set('kind', data.kind);
		if (data.model) p.set('model', data.model);
		if (!stacking) p.set('stack', 'false');
		p.set('tzOffset', String(tzOffset()));
		return p;
	}

	async function fetchUnitsPage(offset: number, limit: number): Promise<GalleryUnitsPage> {
		const p = galleryFilterParams();
		p.set('offset', String(offset));
		p.set('limit', String(limit));
		const res = await fetchWithTimeout(`/api/media/units?${p}`);
		if (!res.ok) throw new Error(`Server returned ${res.status}`);
		return res.json();
	}

	const feed = new GalleryFeed({
		fetchPage: fetchUnitsPage,
		onError: (m) => (loadError = m),
	});
	// True until the first browse layout lands (browse isn't SSR'd — see the load
	// function), so the grid shows a skeleton rather than a false "empty" state.
	// svelte-ignore state_referenced_locally
	let browseLoading = $state(data.mode === 'browse');

	// Search results (flat, ranked). Only used in search mode.
	// svelte-ignore state_referenced_locally
	let searchItems = $state<MediaListItem[]>(
		data.mode === 'search' ? [...(data.searchItems ?? [])] : [],
	);

	// Monotonic token guarding `reloadFeed` against out-of-order responses: a
	// rapid filter/stacking toggle fires overlapping reloads, and without this the
	// last one to *resolve* (not the last issued) would win and install a stale
	// filter's layout. Bumped synchronously at entry; a superseded call bails
	// before committing. (`feed.#generation` only guards demand-loaded pages, not
	// the reseed itself.)
	let reloadGen = 0;

	// Refetch the whole layout + first units page with the real tz / current
	// stacking. Bumps the feed generation, so any in-flight page from the previous
	// filter/tz is discarded rather than landing in the fresh cache.
	async function reloadFeed(resetScroll = false) {
		const gen = ++reloadGen;
		const p = galleryFilterParams();
		const unitsParams = galleryFilterParams();
		unitsParams.set('offset', '0');
		unitsParams.set('limit', String(GalleryFeed.PAGE));
		try {
			const [lr, ur] = await Promise.all([
				fetchWithTimeout(`/api/media/layout?${p}`),
				fetchWithTimeout(`/api/media/units?${unitsParams}`),
			]);
			if (!lr.ok || !ur.ok) throw new Error('Failed to load gallery');
			const layout = (await lr.json()) as GalleryLayout;
			const unitsPage = (await ur.json()) as GalleryUnitsPage;
			if (gen !== reloadGen) return; // superseded by a newer reload — discard
			feed.seed(layout, unitsPage.units);
			loadError = null;
			// On a filter/stacking change, snap to the top as the new layout lands:
			// the seeded first page always covers the top viewport, so the grid fills
			// with real tiles instead of flashing placeholders (which a deep scroll
			// position would show until its range demand-loaded). Matches the old
			// filter-switch scroll reset. A delete keeps its place instead.
			if (resetScroll && scrollContainer) {
				scrollContainer.scrollTop = 0;
				scrollTop = 0;
			}
		} catch (e) {
			if (gen === reloadGen) loadError = e instanceof Error ? e.message : 'Failed to load gallery';
		} finally {
			// Only the latest reload owns the skeleton flag — a superseded call must
			// not clear it while the current one is still loading.
			if (gen === reloadGen) browseLoading = false;
		}
	}

	// Keep search results in sync with SSR navigation (each keystroke re-runs load).
	$effect(() => {
		if (data.mode === 'search') searchItems = [...(data.searchItems ?? [])];
	});

	// Load / reload the browse layout+units client-side whenever the filters or
	// stacking change (and once on mount). Fetched here — not SSR'd — so the day
	// buckets use the viewer's real tz. Waits for the tiles before any test/user
	// interaction, so there's no mid-interaction reseed.
	$effect(() => {
		if (searching) return;
		// deps: filters + stacking
		void data.kind;
		void data.model;
		void stacking;
		// Skeleton only for a genuine first load (no layout yet); a filter/stacking
		// change keeps the current grid until the new units land. untrack so reading
		// the layout doesn't feed back into this effect.
		if (untrack(() => feed.layout) === null) browseLoading = true;
		reloadFeed(true);
	});

	// --- Filters ------------------------------------------------------------
	const kindFilter = $derived(data.kind);

	const modelOptions = $derived(
		data.model != null && !data.modelFacets.some((f: { value: string }) => f.value === data.model)
			? [...data.modelFacets, { value: data.model, label: data.model, count: 0 }]
			: data.modelFacets,
	);

	function setKind(k: 'image' | 'video' | null) {
		const url = new URL(page.url);
		if (k) url.searchParams.set('kind', k);
		else url.searchParams.delete('kind');
		goto(url, { keepFocus: true, noScroll: true, replaceState: false });
	}

	function setModel(m: string | null) {
		const url = new URL(page.url);
		if (m) url.searchParams.set('model', m);
		else url.searchParams.delete('model');
		goto(url, { keepFocus: true, noScroll: true, replaceState: false });
	}

	// --- Prompt search box --------------------------------------------------
	// svelte-ignore state_referenced_locally
	let queryText = $state(data.q ?? '');
	let queryDebounce: ReturnType<typeof setTimeout> | null = null;
	let searchOpen = $state(false);
	let searchInput = $state<HTMLInputElement | null>(null);
	const searchExpanded = $derived(searchOpen || !!data.q);

	$effect(() => {
		// Keep the box in sync with the URL after a back-nav away from search.
		queryText = data.q ?? '';
	});

	function openSearch() {
		searchOpen = true;
		tick().then(() => searchInput?.focus());
	}
	function onSearchBlur() {
		if (!queryText.trim() && !data.q) searchOpen = false;
	}
	function commitQuery(q: string) {
		const url = new URL(page.url);
		const trimmed = q.trim();
		if (trimmed) url.searchParams.set('q', trimmed);
		else url.searchParams.delete('q');
		goto(url, { keepFocus: true, noScroll: true, replaceState: true });
	}
	function onQueryInput() {
		if (queryDebounce) clearTimeout(queryDebounce);
		queryDebounce = setTimeout(() => commitQuery(queryText), 250);
	}
	function clearQuery() {
		if (queryDebounce) clearTimeout(queryDebounce);
		queryText = '';
		searchOpen = false;
		commitQuery('');
	}

	const viewNonDefault = $derived(!stacking || granularity !== 'month');
	const filterActive = $derived(kindFilter !== null || data.model != null);

	// --- Sections (from the layout) -----------------------------------------
	const sections = $derived(feed.layout ? buildLayoutSections(feed.layout.days, granularity) : []);
	const sectionUnitCounts = $derived(sections.map((s) => s.unitCount));

	// --- Drill-in -----------------------------------------------------------
	// Opening a stack fetches its full member set (thin units hold only ≤4
	// previews). Conversation stacks + prompt runs both resolve via
	// /api/media/unit-members.
	let drillUnit = $state<GalleryUnit | null>(null);
	let drillItems = $state<MediaListItem[] | null>(null);
	let drillLoading = $state(false);
	let drillError = $state<string | null>(null);
	let savedGalleryScroll = 0;

	// Fetch the members of the currently-open stack. Guarded by `drillUnit.key` so
	// a stale response (the user drilled elsewhere meanwhile) can't land.
	async function loadDrillMembers(u: GalleryUnit) {
		drillItems = null;
		drillError = null;
		drillLoading = true;
		const p = new URLSearchParams({ key: u.key });
		if (data.kind) p.set('kind', data.kind);
		if (data.model) p.set('model', data.model);
		try {
			const res = await fetchWithTimeout(`/api/media/unit-members?${p}`);
			if (!res.ok) throw new Error(`Server returned ${res.status}`);
			const body = (await res.json()) as { items: MediaListItem[] };
			if (drillUnit?.key === u.key) drillItems = body.items;
		} catch (e) {
			if (drillUnit?.key === u.key) {
				drillError = e instanceof Error ? e.message : 'Failed to open stack';
				drillItems = [];
			}
		} finally {
			if (drillUnit?.key === u.key) drillLoading = false;
		}
	}

	function openStack(u: GalleryUnit) {
		// Capture the gallery scroll synchronously — and ONLY when entering from the
		// gallery (guarded by `drillUnit === null`), never while already drilled in,
		// so the drill grid's own (near-zero) offset can't clobber the saved gallery
		// position. The DOM swap to the shorter drill grid would otherwise clamp
		// scrollTop before we read it.
		if (drillUnit === null && scrollContainer) savedGalleryScroll = scrollContainer.scrollTop;
		drillUnit = u;
		void loadDrillMembers(u);
		tick().then(() => {
			if (scrollContainer) scrollContainer.scrollTop = 0;
		});
	}

	function closeDrill() {
		drillUnit = null;
		drillItems = null;
		drillError = null;
		tick().then(() => {
			if (scrollContainer) scrollContainer.scrollTop = savedGalleryScroll;
		});
	}

	// --- Lightbox -----------------------------------------------------------
	let lightbox = $state<MediaListItem | null>(null);
	let lightboxConversations = $state<MediaConversationRef[] | null>(null);
	let conversationsError = $state<string | null>(null);

	// Open the lightbox for a media id. Drill/search rows are already full
	// MediaListItems (instant); a top-level grid tile carries only a thin unit,
	// so its leader is fetched.
	async function openLightboxById(id: string) {
		const local =
			drillItems?.find((m) => m.id === id) ??
			(searching ? searchItems.find((m) => m.id === id) : undefined);
		if (local) {
			lightbox = local;
			return;
		}
		try {
			const res = await fetchWithTimeout(`/api/media/${id}`);
			if (!res.ok) throw new Error(`Server returned ${res.status}`);
			lightbox = (await res.json()) as MediaListItem;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to open media';
		}
	}

	// The carousel spans the drilled stack, the search results, or — at the top
	// level — the loaded units' leaders (Google-Photos style: one representative
	// per stack, next swipe moves to the next stack/solo).
	const lightboxSiblings = $derived(
		drillItems
			? drillItems.map((m) => ({ id: m.id, kind: m.kind }))
			: searching
				? searchItems.map((m) => ({ id: m.id, kind: m.kind }))
				: feed.loadedLeaders(),
	);

	// Refetch the open lightbox item's conversation refs whenever it changes.
	$effect(() => {
		const id = lightbox?.id;
		if (!id) {
			lightboxConversations = null;
			conversationsError = null;
			return;
		}
		conversationsError = null;
		const requested = id;
		fetch(`/api/media/${id}/conversations`)
			.then((r) => {
				if (!r.ok) throw new Error(`Server returned ${r.status}`);
				return r.json() as Promise<{ conversations: MediaConversationRef[] }>;
			})
			.then((body) => {
				if (lightbox?.id === requested) lightboxConversations = body.conversations;
			})
			.catch((e) => {
				if (lightbox?.id === requested) {
					conversationsError = e instanceof Error ? e.message : 'Failed to load conversations';
					lightboxConversations = [];
				}
			});
	});

	// --- Selection + delete -------------------------------------------------
	let selectMode = $state(false);
	let selected = $state<Set<string>>(new Set());
	let bulkDeleting = $state(false);
	const selectedCount = $derived(selected.size);

	function enterSelectMode() {
		selectMode = true;
		selected = new Set();
		lightbox = null;
	}
	function exitSelectMode() {
		selectMode = false;
		selected = new Set();
	}
	function toggleSelected(id: string) {
		const next = new Set(selected);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		selected = next;
	}

	// A delete shifts the whole layout (counts change), so refresh the top-level
	// feed. If drilled in, re-resolve the open stack against the deletion rather
	// than blindly re-opening with the stale unit: deleting a prompt run's leader
	// re-keys the run (`p:<leaderId>`), so re-opening with the old key would fetch
	// an empty set and strand a phantom stack. `drillItems` already holds the full
	// member set, so the survivors are known without a refetch.
	async function refreshAfterMutation(deleted: Set<string>) {
		await reloadFeed();
		if (!drillUnit) return;
		const survivors = (drillItems ?? []).filter((m) => !deleted.has(m.id));
		if (survivors.length === 0) {
			// The whole stack is gone — return to the gallery (restores saved scroll).
			closeDrill();
			return;
		}
		// Re-anchor: a conversation stack keeps its stable id key; a prompt run
		// re-keys to its newest surviving member (replacing the old
		// `reanchorDrillOnDelete` from the items-based path).
		const leader = survivors[0];
		drillItems = survivors;
		drillUnit = {
			...drillUnit,
			key: drillUnit.groupKind === 'conversation' ? drillUnit.key : promptRunKey(leader.id),
			leaderId: leader.id,
			leaderKind: leader.kind,
			memberCount: survivors.length,
			label:
				drillUnit.groupKind === 'conversation'
					? drillUnit.label
					: (leader.originalPrompt ?? leader.promptExcerpt ?? 'Untitled'),
		};
	}

	async function deleteOne(id: string) {
		if (deletingId) return;
		const ok = await confirmDialog.ask({
			title: 'Delete this media?',
			message: 'This action cannot be undone.',
		});
		if (!ok) return;
		deletingId = id;
		error = null;
		try {
			const res = await fetch(`/api/media/${id}`, { method: 'DELETE' });
			if (!res.ok && res.status !== 404) throw new Error(`Server returned ${res.status}`);
			if (lightbox?.id === id) lightbox = null;
			await refreshAfterMutation(new Set([id]));
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to delete';
		} finally {
			deletingId = null;
		}
	}

	async function deleteSelected() {
		if (bulkDeleting || selected.size === 0) return;
		const count = selected.size;
		const ok = await confirmDialog.ask({
			title: count === 1 ? 'Delete 1 item?' : `Delete ${count} items?`,
			message: 'This action cannot be undone.',
		});
		if (!ok) return;
		bulkDeleting = true;
		error = null;
		try {
			const ids = Array.from(selected);
			const res = await fetch('/api/media/bulk-delete', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ids }),
			});
			if (!res.ok) throw new Error(`Server returned ${res.status}`);
			exitSelectMode();
			await refreshAfterMutation(new Set(ids));
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to delete';
		} finally {
			bulkDeleting = false;
		}
	}

	// --- Timeline rail ------------------------------------------------------
	const months = $derived(feed.layout ? monthTicksFromLayout(feed.layout.days) : []);
	let activeSectionKey = $state<string | null>(null);

	// Every section header stays mounted (only tiles are windowed), so the rail's
	// header-measurement logic works unchanged.
	const sectionHeaders = new Map<string, HTMLElement>();
	function registerHeader(node: HTMLElement, key: string) {
		sectionHeaders.set(key, node);
		return {
			update(newKey: string) {
				sectionHeaders.delete(key);
				key = newKey;
				sectionHeaders.set(key, node);
			},
			destroy() {
				sectionHeaders.delete(key);
			},
		};
	}

	function jumpToMonth(key: string) {
		if (!scrollContainer) return;
		if (key === months[0]?.key) {
			scrollContainer.scrollTop = 0;
			return;
		}
		// Every month's header is mounted, so a jump is a pure scroll to it — no
		// data re-anchoring (the demand loader fills the range as it lands).
		for (const [sectionKey, el] of sectionHeaders) {
			if (sectionKey.slice(0, 7) === key) {
				scrollContainer.scrollTop +=
					el.getBoundingClientRect().top - scrollContainer.getBoundingClientRect().top;
				return;
			}
		}
	}

	let activeRaf = 0;
	function scheduleActiveUpdate() {
		if (activeRaf) return;
		activeRaf = requestAnimationFrame(() => {
			activeRaf = 0;
			if (scrollContainer) scrollTop = scrollContainer.scrollTop;
			updateActiveSection();
		});
	}
	function updateActiveSection() {
		if (!scrollContainer) return;
		const top = scrollContainer.getBoundingClientRect().top;
		let best: { key: string; delta: number } | null = null;
		for (const [key, el] of sectionHeaders) {
			const delta = el.getBoundingClientRect().top - top;
			if (delta <= 1 && (!best || delta > best.delta)) best = { key, delta };
		}
		activeSectionKey = (best?.key ?? months[0]?.key ?? null)?.slice(0, 7) ?? null;
	}

	// --- Grid virtualization (windowing) ------------------------------------
	// Only the rows near the viewport render; the rest are reserved as padding on
	// each section's grid. Pure arithmetic because every tile is a constant height
	// (caption overlay + aspect-square). See $lib/gallery-window.
	let scrollContainer = $state<HTMLElement | null>(null);
	let gridMetrics = $state<WindowConstants | null>(null);
	let scrollTop = $state(0);
	let viewportH = $state(0);
	const OVERSCAN_PX = 800;
	// Before geometry is measured, render a small probe from the first section so
	// there's a tile to measure without laying out the whole library.
	const PREMEASURE_CAP = 24;

	function measureGrid() {
		const el = scrollContainer;
		if (!el) return;
		viewportH = el.clientHeight;
		const tiles = el.querySelectorAll<HTMLElement>('[data-tile]');
		if (tiles.length === 0) return;
		const ul = tiles[0].parentElement;
		if (!ul) return;
		const cs = getComputedStyle(ul);
		const cols = cs.gridTemplateColumns.split(' ').filter(Boolean).length || 1;
		const firstRect = tiles[0].getBoundingClientRect();
		const tileH = firstRect.height;
		let rowPitch = tileH + parseFloat(cs.rowGap || '0');
		const nextRowTile = tiles[cols];
		if (nextRowTile && nextRowTile.parentElement === ul) {
			rowPitch = nextRowTile.getBoundingClientRect().top - firstRect.top;
		}
		// Header→grid distance from the header's intrinsic box (offsetHeight + its
		// bottom margin) — NOT a rect delta, which a sticky-pinned header corrupts.
		let headerH = 0;
		const header = el.querySelector<HTMLElement>('[data-section-header]');
		if (header) {
			headerH = header.offsetHeight + parseFloat(getComputedStyle(header).marginBottom || '0');
		}
		if (rowPitch <= 0 || tileH <= 0) return;
		const next: WindowConstants = { cols, rowPitch, tileH, headerH };
		const p = gridMetrics;
		if (
			p &&
			p.cols === cols &&
			p.rowPitch === rowPitch &&
			p.tileH === tileH &&
			p.headerH === headerH
		) {
			return;
		}
		gridMetrics = next;
	}

	$effect(() => {
		const el = scrollContainer;
		if (!el) return;
		measureGrid();
		const ro = new ResizeObserver(() => measureGrid());
		ro.observe(el);
		return () => ro.disconnect();
	});

	// Re-measure after the rendered structure changes shape.
	$effect(() => {
		void searching;
		void drillUnit;
		void granularity;
		void feed.totalUnits;
		void (drillItems?.length ?? 0);
		void searchItems.length;
		if (scrollContainer) tick().then(measureGrid);
	});

	const viewport = $derived({ scrollTop, viewportH, overscanPx: OVERSCAN_PX });

	// Per-section windows for the browse grid.
	const sectionWindows = $derived(
		gridMetrics && viewportH > 0
			? computeSectionWindows(sectionUnitCounts, gridMetrics, viewport)
			: null,
	);

	// A window over a flat (section-less) list — search + drill-in.
	function flatWindow(count: number) {
		if (!gridMetrics || viewportH === 0) return null;
		return computeSectionWindows([count], gridMetrics, viewport)[0];
	}

	// The global unit indices to render for a browse section: the windowed slice,
	// or (pre-measure) a bounded probe from the first section only.
	function unitIndices(
		section: { startIndex: number; unitCount: number },
		i: number,
		win: { firstUnit: number; unitEnd: number } | null,
	): number[] {
		if (win) return range(section.startIndex + win.firstUnit, section.startIndex + win.unitEnd);
		if (i !== 0) return [];
		const n = Math.min(section.unitCount, PREMEASURE_CAP);
		return range(section.startIndex, section.startIndex + n);
	}

	function range(a: number, b: number): number[] {
		const n = Math.max(0, b - a);
		return Array.from({ length: n }, (_, k) => a + k);
	}

	// Demand-load the visible unit ranges as the window moves.
	$effect(() => {
		if (searching || drillUnit) return;
		const wins = sectionWindows;
		if (!wins) return;
		for (let i = 0; i < sections.length; i++) {
			const w = wins[i];
			const s = sections[i];
			if (w && w.rowCount > 0)
				feed.ensureRange(s.startIndex + w.firstUnit, s.startIndex + w.unitEnd);
		}
	});

	// Content/empty state per mode.
	const isEmpty = $derived(
		searching
			? searchItems.length === 0
			: drillUnit
				? drillItems?.length === 0
				: feed.totalUnits === 0,
	);
	const hasContent = $derived(
		searching
			? searchItems.length > 0
			: drillUnit
				? (drillItems?.length ?? 0) > 0
				: feed.totalUnits > 0,
	);
	const loadedCount = $derived(
		searching ? searchItems.length : drillUnit ? (drillItems?.length ?? 0) : feed.totalUnits,
	);
</script>

<div class="flex h-full flex-col overflow-hidden">
	<header class="flex shrink-0 items-center justify-between gap-3 px-4 py-3">
		<div class="flex min-w-0 items-center gap-2">
			{#if drillUnit}
				<button
					type="button"
					onclick={closeDrill}
					class="-ml-1 flex shrink-0 items-center gap-1 rounded-md px-2 py-1.5 text-sm transition hover:bg-surface-raised"
					aria-label="Back to gallery"
				>
					<ChevronLeft size={18} />
					Back
				</button>
				<h1 class="truncate text-lg font-semibold tracking-tight">{drillUnit.label}</h1>
				<span class="shrink-0 text-xs text-fg-muted">{drillUnit.memberCount}</span>
				{#if drillLoading}
					<span class="shrink-0 text-xs text-fg-subtle">updating…</span>
				{:else if drillError}
					<span class="shrink-0 text-xs text-danger-fg" title={drillError}>partial</span>
				{/if}
			{:else}
				<h1 class="text-lg font-semibold tracking-tight">Gallery</h1>
			{/if}
		</div>
		<div class="flex flex-wrap items-center gap-2 text-xs sm:justify-end">
			{#if selectMode}
				<span class="text-fg-muted">
					{selectedCount === 0 ? 'Select items' : `${selectedCount} selected`}
				</span>
				<button
					type="button"
					onclick={deleteSelected}
					disabled={bulkDeleting || selectedCount === 0}
					class="inline-flex h-8 items-center rounded-md btn-danger px-3 transition disabled:opacity-40"
				>
					{bulkDeleting ? 'Deleting…' : 'Delete'}
				</button>
				<button
					type="button"
					onclick={exitSelectMode}
					disabled={bulkDeleting}
					class="inline-flex h-8 items-center rounded-md border border-border-strong bg-surface-panel px-3 transition hover:bg-surface-raised disabled:opacity-40"
				>
					Cancel
				</button>
			{:else}
				{#snippet kindFacet()}
					<div
						class="inline-flex overflow-hidden rounded-md border border-border-strong"
						role="group"
						aria-label="Filter by media kind"
					>
						{#each [{ k: null, label: 'All' }, { k: 'image', label: 'Images' }, { k: 'video', label: 'Videos' }] as { k, label }, i (label)}
							{@const active = kindFilter === k}
							<button
								type="button"
								onclick={() => setKind(k as 'image' | 'video' | null)}
								aria-pressed={active}
								class="px-3 py-1.5 transition {i > 0 ? 'border-l border-border-strong' : ''} {active
									? 'bg-surface-inverse text-fg-inverse'
									: 'bg-surface-panel hover:bg-surface-raised'}"
							>
								{label}
							</button>
						{/each}
					</div>
				{/snippet}
				{#snippet modelFacet()}
					{#if modelOptions.length >= 2 || data.model != null}
						{@const modelActive = data.model != null}
						<select
							value={data.model ?? ''}
							onchange={(e) => setModel(e.currentTarget.value || null)}
							title="Filter by model"
							aria-label="Filter by model"
							class="max-w-[12rem] rounded-md border px-3 py-1.5 transition {modelActive
								? 'border-surface-inverse bg-surface-inverse text-fg-inverse'
								: 'border-border-strong bg-surface-panel hover:bg-surface-raised'}"
						>
							<option value="">All models</option>
							{#each modelOptions as f (f.value)}
								<option value={f.value}>{f.label} ({f.count})</option>
							{/each}
						</select>
					{/if}
				{/snippet}
				{#if !drillUnit}
					{#if searchExpanded}
						<div class="relative">
							<input
								type="search"
								bind:this={searchInput}
								bind:value={queryText}
								oninput={onQueryInput}
								onblur={onSearchBlur}
								placeholder="Search prompts…"
								aria-label="Search prompts"
								class="h-8 w-40 rounded-md border border-border-strong bg-surface-panel px-3 pr-7 text-base leading-4 transition focus:border-border-focus focus:outline-none sm:w-52 sm:text-xs"
							/>
							{#if queryText}
								<button
									type="button"
									onclick={clearQuery}
									aria-label="Clear search"
									class="absolute top-1/2 right-1.5 -translate-y-1/2 px-1 text-fg-muted transition hover:text-fg-default"
								>
									×
								</button>
							{/if}
						</div>
					{:else}
						<button
							type="button"
							onclick={openSearch}
							aria-label="Search prompts"
							title="Search prompts"
							class="flex h-8 items-center justify-center rounded-md border border-border-strong bg-surface-panel px-1.5 text-fg-secondary transition hover:bg-surface-raised"
						>
							<Search size={16} />
						</button>
					{/if}
					<!-- Kind + model facets: inline on desktop; on mobile they move into the
					     View popover below to keep the bar to a single row. -->
					<div class="hidden sm:contents">
						{@render kindFacet()}
						{@render modelFacet()}
					</div>
					<Popover.Root>
						<Popover.Trigger
							aria-label="View options"
							title="View options"
							class="relative flex items-center justify-center rounded-md border border-border-strong bg-surface-panel p-1.5 text-fg-secondary transition hover:bg-surface-raised {searching
								? 'sm:hidden'
								: ''}"
						>
							<SlidersHorizontal size={16} />
							{#if !searching && viewNonDefault}
								<span
									class="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-warning ring-2 ring-surface-panel"
									aria-hidden="true"
								></span>
							{:else if filterActive}
								<span
									class="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-warning ring-2 ring-surface-panel sm:hidden"
									aria-hidden="true"
								></span>
							{/if}
						</Popover.Trigger>
						<Popover.Portal>
							<Popover.Content
								sideOffset={6}
								align="end"
								avoidCollisions
								collisionPadding={{ top: 60, right: 12, bottom: 12, left: 12 }}
								class="z-50 flex w-72 flex-col gap-1 rounded-lg border border-border surface-glass gs-pop p-2 text-sm shadow-lg"
							>
								<!-- Filter section: mobile only (desktop shows these inline). -->
								<div class="flex flex-col gap-1 sm:hidden">
									<div class="px-2 pt-1 text-xs font-medium tracking-wide text-fg-muted uppercase">
										Filter
									</div>
									<div class="flex items-center justify-between gap-3 p-2">
										<span class="font-medium text-fg">Type</span>
										{@render kindFacet()}
									</div>
									{#if modelOptions.length >= 2 || data.model != null}
										<div class="flex items-center justify-between gap-3 p-2">
											<span class="font-medium text-fg">Model</span>
											{@render modelFacet()}
										</div>
									{/if}
									{#if !searching}
										<div class="mt-1 border-t border-border"></div>
										<div
											class="px-2 pt-1 text-xs font-medium tracking-wide text-fg-muted uppercase"
										>
											View
										</div>
									{/if}
								</div>
								{#if !searching}
									<label
										class="flex cursor-pointer items-center justify-between gap-3 rounded-md p-2 transition hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
									>
										<span class="font-medium text-fg">Stack related media</span>
										<Switch.Root
											checked={stacking}
											onCheckedChange={(c) => (stacking = c)}
											aria-label="Stack"
											class="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition data-[state=checked]:bg-surface-inverse data-[state=unchecked]:bg-surface-sunken focus-visible:ring-2 focus-visible:ring-border-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface-panel focus-visible:outline-none"
										>
											<Switch.Thumb
												class="block h-4 w-4 translate-x-0.5 rounded-full bg-surface-panel shadow-sm transition data-[state=checked]:translate-x-[1.125rem]"
											/>
										</Switch.Root>
									</label>
									<div
										class="flex items-center justify-between gap-3 p-2"
										role="group"
										aria-label="Date grouping granularity"
									>
										<span class="font-medium text-fg">Group by</span>
										<div
											class="inline-flex overflow-hidden rounded-md border border-border-strong text-xs"
										>
											{#each [{ g: 'day', label: 'Day' }, { g: 'month', label: 'Month' }] as { g, label }, i (g)}
												{@const active = granularity === g}
												<button
													type="button"
													onclick={() => (granularity = g as Granularity)}
													aria-pressed={active}
													class="px-3 py-1.5 transition {i > 0
														? 'border-l border-border-strong'
														: ''} {active
														? 'bg-surface-inverse text-fg-inverse'
														: 'bg-surface-panel hover:bg-surface-raised'}"
												>
													{label}
												</button>
											{/each}
										</div>
									</div>
								{/if}
							</Popover.Content>
						</Popover.Portal>
					</Popover.Root>
				{/if}
				{#if hasContent}
					<button
						type="button"
						onclick={enterSelectMode}
						aria-label="Select items"
						title="Select"
						class="flex items-center justify-center rounded-md border border-border-strong bg-surface-panel p-1.5 text-fg-secondary transition hover:bg-surface-raised"
					>
						<SquareCheck size={16} />
					</button>
				{/if}
			{/if}
		</div>
	</header>

	<div class="relative flex-1 overflow-hidden">
		<div
			bind:this={scrollContainer}
			onscroll={scheduleActiveUpdate}
			data-loaded-count={loadedCount}
			class="h-full overflow-y-auto pt-4 pb-4 pl-4 {!drillUnit && months.length > 1
				? 'pr-9'
				: 'pr-4'}"
		>
			{#if !searching && !drillUnit && browseLoading}
				<!-- Browse isn't SSR'd (tz-dependent buckets), so cover the initial
				     layout round-trip with a skeleton instead of a false empty state. -->
				<ul
					class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6"
					aria-hidden="true"
				>
					{#each range(0, 18) as i (i)}
						<li
							class="aspect-square w-full animate-pulse rounded-lg border border-border bg-surface-panel"
						></li>
					{/each}
				</ul>
			{:else if isEmpty}
				<div class="flex h-full flex-col items-center justify-center text-center">
					{#if searching}
						<p class="text-sm text-fg-muted">No results for "{data.q}".</p>
						<p class="mt-1 text-xs text-fg-subtle">Try different or fewer words.</p>
					{:else}
						<p class="text-sm text-fg-muted">No media yet.</p>
						<p class="mt-1 text-xs text-fg-subtle">
							Generated images and videos from your chats appear here.
						</p>
					{/if}
				</div>
			{:else}
				<!-- A single media tile from a full MediaListItem — shared by search +
				     drill-in. Grid tiles use the /thumbnail variant (512px sharp resize,
				     disk-cached), not the full-resolution /content the lightbox pulls. -->
				{#snippet mediaTile(m: MediaListItem)}
					{@const isSelected = selectMode && selected.has(m.id)}
					<li
						data-tile
						class="group relative overflow-hidden rounded-lg border bg-surface-raised transition {isSelected
							? 'border-surface-inverse ring-2 ring-surface-inverse'
							: 'border-border hover:border-border-focus'}"
					>
						<button
							type="button"
							onclick={() => (selectMode ? toggleSelected(m.id) : (lightbox = m))}
							class="block w-full"
							aria-label={selectMode
								? isSelected
									? `Deselect ${m.kind}`
									: `Select ${m.kind}`
								: `Open ${m.kind} ${m.promptExcerpt ?? ''}`}
							aria-pressed={selectMode ? isSelected : undefined}
						>
							<div class="relative aspect-square w-full overflow-hidden">
								{#if m.kind === 'image'}
									<img
										src="/api/media/{m.id}/thumbnail"
										alt={m.promptExcerpt ?? 'Generated image'}
										loading="lazy"
										class="h-full w-full object-cover"
									/>
								{:else}
									<!-- svelte-ignore a11y_media_has_caption -->
									<video
										src="/api/media/{m.id}/content#t=0.1"
										preload="metadata"
										muted
										playsinline
										class="h-full w-full object-cover"
									></video>
									<div
										class="absolute right-1.5 top-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-white"
									>
										video
									</div>
								{/if}
								{#if m.promptExcerpt}
									<div
										class="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/60 to-transparent px-2 pb-1.5 pt-8 text-left text-xs text-white line-clamp-2"
									>
										{m.promptExcerpt}
									</div>
								{/if}
							</div>
						</button>
						{#if selectMode}
							<span
								aria-hidden="true"
								class="pointer-events-none absolute left-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full border-2 text-[12px] font-bold transition {isSelected
									? 'border-surface-inverse bg-surface-inverse text-fg-inverse'
									: 'border-white/80 bg-black/40 text-transparent'}"
							>
								✓
							</span>
						{:else}
							<button
								type="button"
								onclick={() => deleteOne(m.id)}
								disabled={deletingId === m.id}
								class="absolute left-1.5 top-1.5 rounded bg-danger-emphasis/90 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-danger-fg opacity-0 transition group-hover:opacity-100 hover:bg-danger-emphasis disabled:opacity-50"
								aria-label="Delete this media"
								title="Delete"
							>
								{deletingId === m.id ? '…' : '×'}
							</button>
						{/if}
					</li>
				{/snippet}

				<!-- A solo grid tile from a thin unit (top-level browse). Same visual as
				     mediaTile, but built from the unit's leader + it fetches the full item
				     lazily when opened. -->
				{#snippet unitTile(u: GalleryUnit)}
					{@const isSelected = selectMode && selected.has(u.leaderId)}
					<li
						data-tile
						class="group relative overflow-hidden rounded-lg border bg-surface-raised transition {isSelected
							? 'border-surface-inverse ring-2 ring-surface-inverse'
							: 'border-border hover:border-border-focus'}"
					>
						<button
							type="button"
							onclick={() =>
								selectMode ? toggleSelected(u.leaderId) : openLightboxById(u.leaderId)}
							class="block w-full"
							aria-label={selectMode
								? isSelected
									? `Deselect ${u.leaderKind}`
									: `Select ${u.leaderKind}`
								: `Open ${u.leaderKind} ${u.excerpt ?? ''}`}
							aria-pressed={selectMode ? isSelected : undefined}
						>
							<div class="relative aspect-square w-full overflow-hidden">
								{#if u.leaderKind === 'image'}
									<img
										src="/api/media/{u.leaderId}/thumbnail"
										alt={u.excerpt ?? 'Generated image'}
										loading="lazy"
										class="h-full w-full object-cover"
									/>
								{:else}
									<!-- svelte-ignore a11y_media_has_caption -->
									<video
										src="/api/media/{u.leaderId}/content#t=0.1"
										preload="metadata"
										muted
										playsinline
										class="h-full w-full object-cover"
									></video>
									<div
										class="absolute right-1.5 top-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-white"
									>
										video
									</div>
								{/if}
								{#if u.excerpt}
									<div
										class="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/60 to-transparent px-2 pb-1.5 pt-8 text-left text-xs text-white line-clamp-2"
									>
										{u.excerpt}
									</div>
								{/if}
							</div>
						</button>
						{#if selectMode}
							<span
								aria-hidden="true"
								class="pointer-events-none absolute left-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full border-2 text-[12px] font-bold transition {isSelected
									? 'border-surface-inverse bg-surface-inverse text-fg-inverse'
									: 'border-white/80 bg-black/40 text-transparent'}"
							>
								✓
							</span>
						{:else}
							<button
								type="button"
								onclick={() => deleteOne(u.leaderId)}
								disabled={deletingId === u.leaderId}
								class="absolute left-1.5 top-1.5 rounded bg-danger-emphasis/90 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-danger-fg opacity-0 transition group-hover:opacity-100 hover:bg-danger-emphasis disabled:opacity-50"
								aria-label="Delete this media"
								title="Delete"
							>
								{deletingId === u.leaderId ? '…' : '×'}
							</button>
						{/if}
					</li>
				{/snippet}

				<!-- A stack card: a 2×2 collage of the newest members + a "+N" cell.
				     Clicking drills into the stack. -->
				{#snippet unitCard(u: GalleryUnit)}
					{@const previews = u.memberCount > 4 ? u.previews.slice(0, 3) : u.previews}
					{@const remaining = u.memberCount - previews.length}
					<li
						data-tile
						class="group relative overflow-hidden rounded-lg border border-border bg-surface-raised transition hover:border-border-focus"
					>
						<button
							type="button"
							onclick={() => openStack(u)}
							class="block w-full"
							aria-label={`Open stack: ${u.label} (${u.memberCount} items)`}
						>
							<div class="relative aspect-square w-full overflow-hidden bg-surface-panel">
								<div class="grid h-full w-full grid-cols-2 grid-rows-2 gap-px">
									{#each previews as p (p.id)}
										<div class="relative overflow-hidden bg-surface-panel">
											{#if p.kind === 'image'}
												<img
													src="/api/media/{p.id}/thumbnail"
													alt=""
													loading="lazy"
													class="h-full w-full object-cover"
												/>
											{:else}
												<!-- svelte-ignore a11y_media_has_caption -->
												<video
													src="/api/media/{p.id}/content#t=0.1"
													preload="metadata"
													muted
													playsinline
													class="h-full w-full object-cover"
												></video>
											{/if}
										</div>
									{/each}
									{#if remaining > 0}
										<div
											class="flex items-center justify-center bg-surface-inverse/80 text-sm font-semibold text-fg-inverse"
										>
											+{remaining}
										</div>
									{/if}
								</div>
								<div
									class="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/60 to-transparent px-2 pb-1.5 pt-8 text-white"
								>
									<div class="truncate text-left text-xs">{u.label}</div>
									<div class="text-left text-[10px] text-white/80">
										{u.memberCount} item{u.memberCount === 1 ? '' : 's'}
									</div>
								</div>
							</div>
						</button>
					</li>
				{/snippet}

				<!-- A not-yet-loaded unit: an empty box that reserves the tile's constant
				     height until its demand-load lands. Carries data-tile so measurement
				     works even when only placeholders are on screen. -->
				{#snippet placeholderTile()}
					<li
						data-tile
						class="relative overflow-hidden rounded-lg border border-border bg-surface-raised"
						aria-hidden="true"
					>
						<div class="aspect-square w-full animate-pulse bg-surface-panel"></div>
					</li>
				{/snippet}

				<!-- A sticky time header; `registerHeader` tracks its element for
				     quick-jump scroll-to + active-month highlighting. `-top-4` cancels the
				     scroll container's `pt-4` so it pins flush. -->
				{#snippet sectionHeader(label: string, key: string)}
					<h2
						use:registerHeader={key}
						data-section-header
						class="sticky -top-4 z-10 -mx-4 mb-3 bg-surface px-4 py-2 text-sm font-semibold text-fg-secondary"
					>
						{label}
					</h2>
				{/snippet}

				{#if searching}
					<!-- Search: a flat relevance-ranked grid (no date sections). Windowed as
					     a single section. -->
					{@const win = flatWindow(searchItems.length)}
					<p class="mb-3 text-xs text-fg-muted">
						{searchItems.length} result{searchItems.length === 1 ? '' : 's'} for "{data.q}"
					</p>
					<ul
						class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6"
						style={win ? `padding-top:${win.padTop}px;padding-bottom:${win.padBottom}px` : ''}
					>
						{#each win ? searchItems.slice(win.firstUnit, win.unitEnd) : searchItems as m (m.id)}
							{@render mediaTile(m)}
						{/each}
					</ul>
				{:else if drillUnit}
					<!-- Drill-in: this stack's members (no date sections). -->
					{@const drilled = drillItems ?? []}
					{@const win = flatWindow(drilled.length)}
					<ul
						class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6"
						style={win ? `padding-top:${win.padTop}px;padding-bottom:${win.padBottom}px` : ''}
					>
						{#each win ? drilled.slice(win.firstUnit, win.unitEnd) : drilled as m (m.id)}
							{@render mediaTile(m)}
						{/each}
					</ul>
				{:else}
					<!-- Browse: date sections reserved from the layout counts; only the
					     units near the viewport render, the rest are padding + placeholders
					     that fill as they demand-load. -->
					{#each sections as section, i (section.key)}
						{@const win = sectionWindows?.[i] ?? null}
						{@render sectionHeader(section.label, section.key)}
						<ul
							class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6"
							style={win ? `padding-top:${win.padTop}px;padding-bottom:${win.padBottom}px` : ''}
						>
							{#each unitIndices(section, i, win) as gi (gi)}
								{@const unit = feed.unitAt(gi)}
								{#if !unit}
									{@render placeholderTile()}
								{:else if unit.groupKind === 'solo'}
									{@render unitTile(unit)}
								{:else}
									{@render unitCard(unit)}
								{/if}
							{/each}
						</ul>
					{/each}
				{/if}
			{/if}

			{#if loadError}
				<!-- Browse layout/units load failure (incl. a timed-out fetch or a
				     failed demand page). Retry re-runs the load, which reseeds the feed
				     and clears any failed-page markers so the range is fetched again. -->
				<div
					class="mt-4 flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm alert-danger"
				>
					<span>{loadError}</span>
					<button
						type="button"
						onclick={() => {
							loadError = null;
							reloadFeed();
						}}
						class="shrink-0 rounded-md border border-border-strong bg-surface-panel px-3 py-1 text-xs transition hover:bg-surface-raised"
					>
						Retry
					</button>
				</div>
			{/if}

			{#if error}
				<!-- Delete / lightbox failure. Distinct from loadError (no Retry — there's
				     nothing for a generic reload to re-attempt); re-doing the action
				     clears it. -->
				<div class="mt-4 rounded-md border px-3 py-2 text-sm alert-danger">
					{error}
				</div>
			{/if}
		</div>
		{#if !drillUnit && months.length > 1}
			<GalleryTimelineRail
				class="absolute inset-y-0 right-0 z-20 w-7"
				periods={months}
				activeKey={activeSectionKey}
				onjump={jumpToMonth}
			/>
		{/if}
	</div>
</div>

<MediaLightbox
	media={lightbox}
	onClose={() => (lightbox = null)}
	onDelete={deleteOne}
	{deletingId}
	conversationsUsingThis={lightboxConversations}
	{conversationsError}
	siblings={lightboxSiblings}
	onNavigate={openLightboxById}
/>
