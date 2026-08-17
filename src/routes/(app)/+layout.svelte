<script lang="ts">
	import type { LayoutData } from './$types';
	import { browser } from '$app/environment';
	import { resolve } from '$app/paths';
	import { onMount, untrack } from 'svelte';
	import type { Snippet } from 'svelte';
	import { reconcileSubscription } from '$lib/push-subscribe';
	import { syncTimeZone } from '$lib/timezone-sync';
	import { flip } from 'svelte/animate';
	import { cubicOut } from 'svelte/easing';
	import { prefersReducedMotion } from 'svelte/motion';
	import { MediaQuery } from 'svelte/reactivity';
	import { goto, invalidate, invalidateAll } from '$app/navigation';
	import { navigating, page } from '$app/state';
	import { DropdownMenu } from 'bits-ui';
	import Toaster from '$lib/components/Toaster.svelte';
	import DeleteConversationDialog from '$lib/components/DeleteConversationDialog.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import { createDoubleActivate } from '$lib/double-activate';
	import { toast } from '$lib/toast.svelte';
	import { searchModal } from '$lib/search-modal.svelte';
	import ScrollPane from '$lib/components/ScrollPane.svelte';
	import { ConversationUiActions } from '$lib/conversation-ui-actions.svelte';
	import { syncThemeColorMeta } from '$lib/theme-color';
	import { FavoritesDrag } from '$lib/favorites-drag.svelte';
	import { isTitlePending } from '$lib/title-pending.svelte';
	import {
		anyGenerating,
		isGenerating,
		markGenerating,
		reconcileGenerating,
	} from '$lib/generating-conversations.svelte';
	import { MAX_CONVERSATION_TITLE_LENGTH } from '$lib/types/api';
	import {
		Archive,
		ChevronDown,
		Image as ImageIcon,
		Images,
		Menu,
		MoreVertical,
		PanelLeftClose,
		PanelLeftOpen,
		Pencil,
		Plus,
		Search,
		SlidersHorizontal,
		Sparkles,
		Trash2,
		User as UserIcon,
		VenetianMask,
		Video as VideoIcon,
	} from '@lucide/svelte';
	import type { ModelKind } from '$lib/types/api';
	import { privateView } from '$lib/private-chat.svelte';

	let { data, children }: { data: LayoutData; children: Snippet } = $props();

	// Heal a lapsed push subscription on load. The settings toggle is the only
	// thing that *creates* a subscription, so once the OS/push service drops it
	// (iOS eviction, PWA re-add, a server-side 404/410 prune) it stays dead while
	// the pref still reads "on" — notifications silently stop. Reconciling here,
	// on every cold app load, re-registers it. No-op (and no permission prompt)
	// unless the user has opted in and already granted permission.
	onMount(() => {
		void reconcileSubscription(data.prefs?.notificationsEnabled ?? false);
		// The server can't know the user's timezone, and a self-hosted box is often
		// in a different one (a VPS abroad, or the owner travelling). Without this
		// the model is told the SERVER's date, which can be the wrong day. No-ops
		// unless the browser's zone actually differs from what's stored.
		void syncTimeZone(data.prefs);
	});

	// Pull the conversation list forward when the app resumes from the
	// background. The sidebar is SSR load data (see +layout.server.ts), so a
	// conversation started on another client (desktop → this phone's PWA) stays
	// invisible until something re-runs the layout load. `visibilitychange`
	// covers tab/app switches, window `focus` covers desktop refocus, and
	// `pageshow` catches iOS PWA / bfcache restores where visibilitychange
	// doesn't fire. Targeted `invalidate` re-runs only this layout load — an
	// in-flight chat page load / stream stays untouched. Skipped while hidden or
	// offline; the resume event fires again once we're actually foregrounded.
	// Bound via <svelte:window>/<svelte:document> at the bottom of the template.
	// Non-$state: this only coalesces concurrent refreshes, nothing renders it.
	let resumeInFlight = false;
	function refreshConversations() {
		if (document.visibilityState !== 'visible' || !navigator.onLine) return;
		// Coalesce the visibilitychange + focus pair a single resume fires.
		if (resumeInFlight) return;
		resumeInFlight = true;
		void invalidate('app:conversations')
			.catch(() => {})
			.finally(() => {
				resumeInFlight = false;
			});
	}
	function onResumeVisibility() {
		if (document.visibilityState === 'visible') refreshConversations();
	}
	// Only bfcache restores — a fresh load's pageshow already has current data.
	function onPageShow(e: PageTransitionEvent) {
		if (e.persisted) refreshConversations();
	}

	// Seed the sidebar's generating dots from the server's in-flight registry.
	// The flag set is in-memory, so a reload / cold PWA launch would otherwise
	// forget a generation started before it — including the case this is most
	// useful for: reopening the app on a thread that ISN'T the one still
	// rendering a video. Seeding is also the only path that can surface a
	// generation started on ANOTHER device, since the registry is keyed by
	// conversation rather than by device (the poll never adds).
	//
	// Once, at mount, not on every `data` refresh: mid-session the client's own
	// marks are the authoritative, immediate signal, so re-reading server state
	// on each `invalidateAll` would be redundant work that can only lag them.
	//
	// The conversation being *displayed* is skipped because the chat page owns a
	// strictly better signal for it — `recoveredInFlight` qualifies the same
	// registry timestamp against the branch leaf — and publishes either way.
	// Skipping rather than racing: this layout's effects flush before the child
	// page's, so seeding the displayed id here would only be overwritten a moment
	// later, and the page's verdict is the one we want anyway.
	onMount(() => {
		for (const id of data.generatingIds) {
			if (id !== page.params.id) markGenerating(id);
		}
	});

	// Poll for completions while any dot is showing. Nothing local is listening
	// to a generation the user has navigated away from (the chat page aborts its
	// fetch on the way out and the server finishes on its own), so this is the
	// only thing that ever takes a dot back off. Gated on a boolean rather than
	// the set itself so one of several conversations finishing doesn't restart
	// the timer, and self-terminating: the last dot clearing stops the interval.
	// `/api/conversations?generating=1` returns bare ids — invalidateAll would
	// re-fetch every endpoint's model list, far too heavy for an interval.
	const GENERATING_POLL_MS = 5000;
	const generatingActive = $derived(anyGenerating());
	$effect(() => {
		if (!generatingActive) return;
		let stopped = false;
		const interval = setInterval(async () => {
			// A backgrounded tab has nobody looking at the dot, and an offline one
			// would just burn retries; the next tick picks it up on return.
			if (document.visibilityState !== 'visible' || !navigator.onLine) return;
			try {
				const res = await fetch('/api/conversations?generating=1');
				if (stopped || !res.ok) return;
				const body = (await res.json()) as { ids: string[] };
				reconcileGenerating(body.ids);
			} catch {
				// Transient — the next tick retries.
			}
		}, GENERATING_POLL_MS);
		return () => {
			stopped = true;
			clearInterval(interval);
		};
	});

	// Shared FLIP config for the sidebar lists. When a conversation gets new
	// activity it jumps to the top of Recents, and a favorites drag reorders
	// the list — `animate:flip` slides the moved rows to their new slot rather
	// than teleporting them, so the reordering reads as motion. Honors
	// prefers-reduced-motion by collapsing the duration to 0. cubicOut decel
	// feels right for a short positional settle. `prefersReducedMotion` is
	// Svelte's built-in reactive query, so toggling the OS setting takes effect
	// live rather than only on the next full load.
	const flipParams = $derived({
		duration: prefersReducedMotion.current ? 0 : 220,
		easing: cubicOut,
	});

	// Keep <html data-theme> in sync with the authoritative theme pref.
	// hooks.server.ts sets it from the gs-theme cookie before first paint
	// (no flash); this re-affirms it from data.prefs (the DB source of
	// truth) after hydration — correcting a stale cookie if the theme was
	// changed on another device — and rewrites the cookie to match.
	// 'glyphstream' is the default and carries no attribute.
	$effect(() => {
		const theme = data.prefs?.theme ?? 'glyphstream';
		const root = document.documentElement;
		if (theme === 'glyphstream') delete root.dataset.theme;
		else root.dataset.theme = theme;
		document.cookie = `gs-theme=${theme}; path=/; max-age=31536000; samesite=lax`;
		syncThemeColorMeta();
	});

	// Color-scheme (light/dark/system). Deliberately TWO effects, because the
	// cookie and the resolution have different triggers:
	//
	//   1. Sync the gs-scheme cookie from the authoritative DB pref, which heals
	//      a stale cross-device cookie. Depends on `data.prefs` ONLY.
	//   2. Resolve data-scheme from the COOKIE plus the live media query.
	//
	// Keeping the write out of the resolver is load-bearing. The Preferences
	// switcher updates the cookie instantly and does NOT invalidate, so between
	// the switch and the next layout load the cookie is fresher than
	// `data.prefs`. If the write shared an effect with the `systemDark.current`
	// read, an OS scheme flip would re-run the whole body and rewrite the cookie
	// from the stale pref — silently reverting the choice the user just made and
	// leaving a year-long cookie that disagrees with the DB, which app.html's
	// inline script then pre-paints from on the next cold load.
	//
	// (Guarding the write with "only if it differs" does NOT fix that: on the
	// flip the cookie says `light` and the stale pref says `system`, so they do
	// differ and the clobbering write still happens.)
	const systemDark = new MediaQuery('prefers-color-scheme: dark', false);
	$effect(() => {
		const pref = data.prefs?.colorScheme ?? 'system';
		document.cookie = `gs-scheme=${pref}; path=/; max-age=31536000; samesite=lax`;
	});
	$effect(() => {
		// Track the pref too — NOT to resolve from, but so a genuine load (the
		// cross-device heal above) re-resolves. Effects run in declaration order,
		// so the cookie write has already landed when this reads it back. Without
		// this dep the split would fix the clobber but leave `data-scheme` stale
		// on a prefs change, since the media query alone wouldn't have fired.
		void data.prefs?.colorScheme;
		// Read unconditionally (not inside the `p !== 'light'` short-circuit
		// below) so this effect always subscribes to the query — matching the old
		// always-registered `change` listener. Otherwise a forced-light cookie
		// would unsubscribe, and a later OS flip wouldn't re-resolve.
		const dark = systemDark.current;
		// Resolve from the COOKIE, not the pref: the Preferences switcher writes
		// it directly without invalidating, so it can be the fresher of the two.
		const m = document.cookie.match(/(?:^|;\s*)gs-scheme=([^;]+)/);
		const p = m ? m[1] : 'system';
		document.documentElement.dataset.scheme =
			p === 'dark' || (p !== 'light' && dark) ? 'dark' : 'light';
		syncThemeColorMeta();
	});

	// Incognito re-tint. The single owner of the `data-private` attribute (app.css
	// keys the violet surface/accent overrides off it). Pages that are private
	// publish it via `privateView.active` — the new-chat toggle and an open
	// private conversation — and clear it on unmount, so navigating to any
	// non-private view drops the re-tint automatically.
	$effect(() => {
		const root = document.documentElement;
		if (privateView.active) root.dataset.private = '';
		else delete root.dataset.private;
	});

	// Sidebar link highlight combines "currently here" with "navigating
	// there." The pending state matters on mobile especially, where
	// there's no hover affordance — tap, then several hundred ms of
	// "nothing happened" until the new route's data finishes loading.
	// Showing the destination link as if it were already active gives
	// continuous feedback that bridges from `:active` (which only lasts
	// while a finger is on the link) through to page-swap.
	const pendingPath = $derived(navigating.to?.url.pathname ?? null);
	const currentPath = $derived(page.url.pathname);
	function activeOrPending(prefix: string): boolean {
		return currentPath.startsWith(prefix) || (pendingPath?.startsWith(prefix) ?? false);
	}
	const galleryActive = $derived(activeOrPending('/gallery'));
	const archivedActive = $derived(activeOrPending('/archived'));
	// Custom Models is the only `/settings/*` route surfaced in the
	// sidebar — Preferences lives in the user-identity menu at the
	// bottom instead, so the top-level entries stay focused on
	// "navigation destinations I visit often."
	const customModelsActive = $derived(activeOrPending('/settings/models'));
	// "New chat" lives at /. Plain string equality (not startsWith) since
	// every path starts with '/' — would otherwise match every nav.
	const newChatPending = $derived(pendingPath === '/');

	/**
	 * Resolved entries for the sidebar's "Favorites" section. Each id in
	 * `data.prefs.favoriteModels` is looked up against the layout-loaded
	 * `data.models` (base models) + `data.customModels` (presets) and
	 * mapped to a label for display. Ids that don't resolve — a deleted
	 * preset, a removed endpoint — are dropped silently rather than
	 * rendered as broken rows. Insertion order is preserved.
	 *
	 * Label rules mirror the picker's `triggerLabel`: custom presets show
	 * their user-given name verbatim; base models drop any `owner/` prefix
	 * so e.g. `meta-llama/Llama-3-70b` becomes `Llama-3-70b`. The full
	 * detail is still reachable via hover (`title=` on the anchor).
	 */
	// Scroll-element handles for the two scrollable sidebar regions. Held
	// so the auto-scroll effects below can imperatively jump them after a
	// list-changing event the user just initiated — adding a favorite, or
	// creating a new conversation — so the new entry is in view rather
	// than hidden below an unscrolled scrollport.
	let favScrollEl = $state<HTMLElement | null>(null);
	let recentsScrollEl = $state<HTMLElement | null>(null);

	// Auto-scroll the favorites pane to the bottom whenever the favorites
	// list grows. New favorites land at the end (insertion order is the
	// stored order), so bottom = latest. Tracked via a length cursor
	// rather than the array reference so unrelated re-renders don't
	// re-trigger the scroll. `untrack`ed on initial mount-pass: on first
	// render the count goes from `undefined` to its real value, which
	// we don't want to read as "the user just added one." `smooth`
	// behavior is fine even on long lists — the browser caps the
	// animation duration.
	let prevFavCount: number | null = null;
	$effect(() => {
		const count = data.prefs?.favoriteModels.length ?? 0;
		if (prevFavCount !== null && count > prevFavCount && favScrollEl) {
			favScrollEl.scrollTo({ top: favScrollEl.scrollHeight, behavior: 'smooth' });
		}
		prevFavCount = count;
	});

	// Mirror for recents: new conversations land at the TOP of the list
	// (the listConversations query orders by updatedAt desc). If the
	// user creates a new conversation while scrolled down in a long
	// recents list, scroll back to the top so the new entry — the
	// thing they just made — is visible.
	let prevConvCount: number | null = null;
	$effect(() => {
		const count = data.conversations.length;
		if (prevConvCount !== null && count > prevConvCount && recentsScrollEl) {
			recentsScrollEl.scrollTo({ top: 0, behavior: 'smooth' });
		}
		prevConvCount = count;
	});

	const favoriteEntries = $derived.by(() => {
		const favs = data.prefs?.favoriteModels ?? [];
		if (favs.length === 0) return [];
		const customById = new Map(data.customModels.map((cm) => [cm.id, cm] as const));
		const baseById = new Map(data.models.map((m) => [m.id, m] as const));
		const out: Array<{ value: string; label: string; kind: ModelKind }> = [];
		for (const id of favs) {
			if (id.startsWith('custom::')) {
				const cm = customById.get(id.slice('custom::'.length));
				if (!cm) continue;
				// A preset's kind tracks its underlying base model — the
				// preset itself is just persona + parameters layered on top.
				const base = baseById.get(`${cm.baseEndpointId}::${cm.baseModelId}`);
				out.push({ value: id, label: cm.name, kind: base?.kind ?? 'chat' });
				continue;
			}
			const base = baseById.get(id);
			if (!base) continue;
			const slash = base.displayName.lastIndexOf('/');
			const label = slash >= 0 ? base.displayName.slice(slash + 1) : base.displayName;
			out.push({ value: id, label, kind: base.kind });
		}
		return out;
	});

	const favDrag = new FavoritesDrag({
		getScrollEl: () => favScrollEl,
		getCurrent: () => data.prefs?.favoriteModels ?? [],
	});

	const convUi = new ConversationUiActions({
		getPathname: () => page.url.pathname,
		goto,
		invalidateAll,
		invalidateConversations: () => invalidate('app:conversations'),
	});

	// Mobile drawer state. The aside is `hidden ... sm:flex` on wide
	// viewports as before; on narrow viewports it slides in from the left
	// when this flag is true. Auto-closes on navigation so picking a
	// conversation doesn't leave the drawer covering the chat.
	let drawerOpen = $state(false);

	// Which conversation's overflow menu is currently open (if any). Used
	// to suppress the drawer's auto-close behavior while a menu is open —
	// otherwise opening the overflow on mobile leaves the menu floating
	// in space while the drawer slides away behind it. Only one menu can
	// be open at a time (opening a new one closes the previous through
	// the onOpenChange callback flipping this slot).
	let openOverflowFor = $state<string | null>(null);

	// Whether the bottom-of-sidebar account dropdown is currently open.
	// Tracked so the <AccountMenuContent> portal (the dropdown's items +
	// their icons) can be dynamic-imported on first open instead of
	// living in the layout chunk for sessions that never open it.
	let accountMenuOpen = $state(false);

	// True while any sidebar-anchored popover is open — the per-conversation
	// overflow menu or the bottom account menu. Both portal out of the
	// translated aside and share the same iOS Safari backdrop race, so both
	// must hold the mobile drawer open (and keep the backdrop inert) while
	// their menu is showing.
	const sidebarMenuOpen = $derived(openOverflowFor !== null || accountMenuOpen);

	// Desktop collapse state. Only affects the sm+ static sidebar; the
	// mobile drawer always opens to the full width when toggled.
	// Persisted in localStorage so the user's preference survives reloads;
	// during SSR there's no localStorage so we default to expanded and
	// accept a brief width animation if the user had collapsed it.
	const COLLAPSE_KEY = 'glyphstream:sidebarCollapsed';
	let collapsed = $state(browser ? localStorage.getItem(COLLAPSE_KEY) === '1' : false);
	$effect(() => {
		localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
	});

	$effect(() => {
		// Re-runs whenever the URL changes; collapse the mobile drawer.
		// Both pathname and search are tracked: sidebar favorites navigate
		// via `/?model=...` which only changes the search string when the
		// user is already on `/`, so pathname alone would leave the drawer
		// open after tapping a favorite on mobile.
		void currentPath;
		void page.url.search;
		// untrack the read so this effect's dep set stays as just the URL.
		// Otherwise dismissing the overflow menu would itself trigger the
		// close — we only want URL changes to do that.
		if (untrack(() => openOverflowFor) !== null) return;
		drawerOpen = false;
	});

	// Global Cmd/Ctrl+K opens the search modal. Convention matches
	// GitHub / Linear / ChatGPT / Claude. We preventDefault so the
	// browser's own K-keyed behavior (e.g. Firefox's search bar in some
	// configs) doesn't fight us. The modal itself handles Escape /
	// arrow / Enter once open — see SearchModal.svelte.
	function onGlobalKey(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
			e.preventDefault();
			searchModal.show();
		}
	}

	// The debug panel's hidden entry point: activate the version number twice
	// in quick succession. A single stray click does nothing and leaves no
	// trace, so the header keeps behaving exactly as it looks.
	//
	// The import is driven from here rather than an `{#await}` in the template
	// for two reasons: the failure path needs to raise a toast, and `toast` is a
	// module singleton that may only be written from an event handler (a
	// `{#await}` `:catch` would be render depth); and a failed import has to put
	// `debugOpen` back, or the double-activate becomes a permanent no-op with no
	// way back but a reload. The chunk isn't precached, so a first open on a
	// dead connection is exactly the case that fails — and it's a plausible one,
	// since a flaky connection is a reason to open this panel.
	let debugOpen = $state(false);
	let DebugPanel = $state<typeof import('$lib/components/DebugPanel.svelte').default | null>(null);

	const onVersionActivate = createDoubleActivate(() => {
		void (async () => {
			try {
				DebugPanel ??= (await import('$lib/components/DebugPanel.svelte')).default;
				debugOpen = true;
			} catch {
				toast.error('Debug info unavailable offline');
			}
		})();
	});
</script>

<div class="app-shell flex overflow-hidden">
	<!-- Mobile drawer backdrop. Pointer-events stay off when the drawer
		 is closed *or* when a sidebar popover is open (a conversation
		 overflow menu or the bottom account menu — see sidebarMenuOpen).
		 The second case defends against an iOS Safari quirk: tapping the
		 trigger inside the translated aside opens the menu via
		 a portal'd popover, and the browser-synthesized click that
		 follows the touch can end up dispatched to the z-drawer-backdrop scrim
		 instead of staying on the trigger — closing the drawer the
		 moment the menu opens. Going inert until the menu closes
		 sidesteps that race entirely. The click handler carries the
		 same guard as belt-and-suspenders in case the class update is
		 batched after the synthesized click dispatches in the same
		 frame. -->
	<button
		type="button"
		aria-label="Close menu"
		onclick={() => {
			if (sidebarMenuOpen) return;
			drawerOpen = false;
		}}
		class="fixed inset-0 z-drawer-backdrop bg-black/40 transition-opacity sm:hidden {drawerOpen
			? 'opacity-100'
			: 'opacity-0'} {drawerOpen && !sidebarMenuOpen
			? 'pointer-events-auto'
			: 'pointer-events-none'}"
	></button>

	<!-- Sidebar.
		 Mobile: fixed slide-in drawer toggled by drawerOpen — always w-64
		 when shown so chat titles remain readable.
		 Desktop (sm+): in-flow column whose width toggles via `collapsed`
		 between w-64 (full) and w-14 (icons only). The conversation list
		 + recents header hide entirely when collapsed; nav items show
		 just their lucide icons with `title` tooltips.
		 The transition list is `translate`, not `transform`: Tailwind v4
		 compiles -translate-x-full to the standalone `translate` property,
		 so naming `transform` here transitions nothing and the drawer pops. -->
	<!--
		`convUi.busyId !== null` makes the entire sidebar inert while an
		archive/delete is in flight. The dropdown menu's Content lives
		in a portal'd subtree (document.body), so the action the user
		just initiated remains responsive — but any sidebar nav link or
		conversation entry that an iOS-synthesized stray click might
		land on after the menu closes is blocked from firing. This
		closes the same hole that left a partly-completed archive
		bouncing the user to /archived as if they'd tapped the
		Archived sidebar link.
	-->
	<aside
		class="fixed inset-y-0 left-0 z-sidebar flex w-64 shrink-0 flex-col overflow-x-hidden border-r border-border bg-surface-sidebar transition-[translate,width] duration-200 sm:static sm:translate-x-0 {drawerOpen
			? 'translate-x-0'
			: '-translate-x-full sm:translate-x-0'} {collapsed ? 'sm:w-14' : 'sm:w-64'} {convUi.busyId !==
		null
			? 'pointer-events-none'
			: ''}"
	>
		<!-- Header row: title (when expanded) + collapse toggle (sm+ only).
			 pt uses max(env(safe-area-inset-top), default) so the title sits
			 below the iOS status bar in PWA standalone mode (viewport-fit=cover
			 + black-translucent status bar, where the top inset is the ~59px
			 status-bar height). Falls through to the default 1rem on desktop /
			 Android / mobile Safari where the inset is 0. -->
		<div
			class="flex items-center {collapsed
				? 'justify-center'
				: 'justify-between'} px-3 pb-2 pt-[max(1rem,env(safe-area-inset-top))] sm:pl-4 sm:pt-4"
		>
			{#if !collapsed}
				<!-- Title + version pair. items-baseline so the smaller
					 version aligns to GlyphStream's baseline rather than
					 floating above it. Version stays muted and small —
					 "you have to be looking for it" affordance for confirming
					 a service-worker refresh or which build is loaded. -->
				<div class="flex items-baseline gap-1.5">
					<a href={resolve('/')} class="font-semibold tracking-tight">GlyphStream</a>
					<!-- Double-activate for the debug panel ("stats for nerds").
						 A button, not the old span: it's interactive now, and that
						 keeps it focusable so two quick Enter presses reach the
						 panel the same way two taps do — counting click events
						 gets keyboard parity for free, which a `dblclick`
						 listener would not. Styled to stay exactly as
						 unremarkable as it was; touch-manipulation so a
						 double-tap opens the panel instead of zooming the page.

						 Deliberately NO aria-label: the rendered "v1.2.3" is the
						 accessible name. An earlier label read "GlyphStream
						 version … Activate twice for debug info", which broke
						 three ways at once — it collided with the theme picker's
						 "GlyphStream Signature frosted glass" button (both are on
						 /settings/preferences, and a `/^GlyphStream/` role query
						 then matches two elements), it announced a deliberately
						 hidden surface to exactly the users who can't see that
						 it's hidden, and it violated WCAG 2.5.3 Label in Name
						 because the visible "v1.2.3" was not a substring of it. -->
					<button
						type="button"
						onclick={onVersionActivate}
						class="cursor-default touch-manipulation border-0 bg-transparent p-0 text-[10px] tabular-nums text-fg-subtle"
					>
						v{__APP_VERSION__}
					</button>
				</div>
			{/if}
			<button
				type="button"
				onclick={() => (collapsed = !collapsed)}
				aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
				title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
				class="hidden h-7 w-7 items-center justify-center rounded text-fg-muted transition hover:bg-surface-sunken/70 hover:text-fg-secondary sm:flex"
			>
				{#if collapsed}
					<PanelLeftOpen size={16} strokeWidth={2.25} />
				{:else}
					<PanelLeftClose size={16} strokeWidth={2.25} />
				{/if}
			</button>
		</div>

		<div class="px-2">
			<a
				href={resolve('/')}
				class="flex items-center gap-2.5 whitespace-nowrap rounded-md px-3 py-2 text-sm transition active:bg-surface-sunken {newChatPending
					? 'bg-surface-sunken text-accent'
					: 'hover:bg-surface-sunken/70'} {collapsed ? 'sm:justify-center sm:px-0' : ''}"
				title={collapsed ? 'New chat' : 'Start a new chat'}
			>
				<Plus size={16} strokeWidth={2.25} class="shrink-0" />
				{#if !collapsed}<span>New chat</span>{/if}
			</a>
			<!--
				Search trigger. Uses the same nav-link styling as the surrounding
				links but acts as a button (opens the modal). The Cmd/Ctrl+K
				hint is only shown when the sidebar is expanded — the collapsed
				icon-only form falls back to the title attribute.
			-->
			<button
				type="button"
				onclick={() => searchModal.show()}
				title={collapsed ? 'Search chats (⌘K)' : 'Search chats'}
				class="flex w-full items-center gap-2.5 whitespace-nowrap rounded-md px-3 py-2 text-left text-sm transition hover:bg-surface-sunken/70 active:bg-surface-sunken {collapsed
					? 'sm:justify-center sm:px-0'
					: ''}"
			>
				<Search size={16} strokeWidth={2.25} class="shrink-0" />
				{#if !collapsed}
					<span class="flex-1">Search</span>
					<kbd
						class="hidden rounded border border-border-strong bg-surface-panel px-1 text-[10px] font-medium text-fg-muted sm:inline"
						aria-hidden="true">⌘K</kbd
					>
				{/if}
			</button>
			<a
				href={resolve('/gallery')}
				title={collapsed ? 'Gallery' : ''}
				class="flex items-center gap-2.5 whitespace-nowrap rounded-md px-3 py-2 text-sm transition active:bg-surface-sunken {galleryActive
					? 'bg-surface-sunken text-accent'
					: 'hover:bg-surface-sunken/70'} {collapsed ? 'sm:justify-center sm:px-0' : ''}"
			>
				<Images size={16} strokeWidth={2.25} class="shrink-0" />
				{#if !collapsed}<span>Gallery</span>{/if}
			</a>
			<a
				href={resolve('/settings/models')}
				title={collapsed ? 'Custom models' : ''}
				class="flex items-center gap-2.5 whitespace-nowrap rounded-md px-3 py-2 text-sm transition active:bg-surface-sunken {customModelsActive
					? 'bg-surface-sunken text-accent'
					: 'hover:bg-surface-sunken/70'} {collapsed ? 'sm:justify-center sm:px-0' : ''}"
			>
				<SlidersHorizontal size={16} strokeWidth={2.25} class="shrink-0" />
				{#if !collapsed}<span>Custom models</span>{/if}
			</a>
			<a
				href={resolve('/archived')}
				title={collapsed ? 'Archived' : ''}
				class="flex items-center gap-2.5 whitespace-nowrap rounded-md px-3 py-2 text-sm transition active:bg-surface-sunken {archivedActive
					? 'bg-surface-sunken text-accent'
					: 'hover:bg-surface-sunken/70'} {collapsed ? 'sm:justify-center sm:px-0' : ''}"
			>
				<Archive size={16} strokeWidth={2.25} class="shrink-0" />
				{#if !collapsed}<span>Archived</span>{/if}
			</a>
		</div>

		<!--
			Favorites: user-pinned models. Sits between the static nav links
			and the Recents list. Clicking an entry lands on the new-chat
			surface with that model preselected via `?model=…` (the home
			page's default-picker effect honors the param). Hidden entirely
			when the user hasn't favorited anything — the header is silent
			rather than dangling above an empty list.
			Collapsed sidebar shows the same entries as icon-only buttons
			with the model name in a hover title so the "quick-access" value
			survives.

			The inner <ul> is capped at 30vh + its own overflow-y-auto so a
			power user with dozens of favorites can't push Recents to zero
			height or shove the account menu below the viewport. Cap is
			vh-based so it scales with the user's window — tall screens
			give favorites more room, short ones constrain them harder.
		-->
		{#if favoriteEntries.length > 0}
			<nav class="mt-2" aria-label="Favorite models">
				{#if !collapsed}
					<h2 class="px-5 pb-1 pt-1 text-[11px] font-medium uppercase tracking-wider text-fg-muted">
						Favorites
					</h2>
				{/if}
				<ScrollPane class="max-h-[30vh] px-2" bind:scrollEl={favScrollEl}>
					<ul bind:this={favDrag.listEl} class="space-y-0.5">
						{#each favoriteEntries as fav (fav.value)}
							{@const isDragging = favDrag.draggingValue === fav.value}
							{@const isDropBefore =
								favDrag.dropTargetValue === fav.value && favDrag.dropPosition === 'before'}
							{@const isDropAfter =
								favDrag.dropTargetValue === fav.value && favDrag.dropPosition === 'after'}
							<li
								animate:flip={flipParams}
								data-value={fav.value}
								draggable="true"
								ondragstart={(e) => favDrag.handleDragStart(e, fav.value)}
								ondragover={(e) => favDrag.handleDragOver(e, fav.value)}
								ondragleave={favDrag.handleDragLeave}
								ondrop={favDrag.handleDrop}
								ondragend={favDrag.handleDragEnd}
								class="rounded-md border-y-2 border-transparent transition {isDragging
									? 'opacity-40'
									: ''} {isDropBefore ? 'border-t-accent!' : ''} {isDropAfter
									? 'border-b-accent!'
									: ''}"
							>
								<a
									draggable="false"
									href={resolve(`/?model=${encodeURIComponent(fav.value)}`)}
									title={fav.label}
									class="flex cursor-grab items-center gap-2.5 whitespace-nowrap rounded-md px-3 py-2 text-sm transition hover:bg-surface-sunken/70 active:cursor-grabbing active:bg-surface-sunken {collapsed
										? 'sm:justify-center sm:px-0'
										: ''}"
								>
									<!--
										Icon picked by modality so the collapsed sidebar
										still conveys "this is the image model" vs "this
										is the chat model" without the label. Mirrors the
										kind glyph on the right side of picker rows;
										using lucide here (rather than the picker's
										emoji) keeps visual parity with the other
										sidebar nav links, which are all lucide icons.
									-->
									{#if fav.kind === 'image'}
										<ImageIcon size={16} strokeWidth={2.25} class="shrink-0 text-favorite" />
									{:else if fav.kind === 'video'}
										<VideoIcon size={16} strokeWidth={2.25} class="shrink-0 text-favorite" />
									{:else}
										<Sparkles size={16} strokeWidth={2.25} class="shrink-0 text-favorite" />
									{/if}
									{#if !collapsed}<span class="min-w-0 truncate">{fav.label}</span>{/if}
								</a>
							</li>
						{/each}
					</ul>
				</ScrollPane>
			</nav>
		{/if}

		<!--
			Conversation list. Hidden when collapsed (desktop); on mobile
			the drawer is always at w-64 so this always shows in the drawer.
			A spacer div fills the flex when the list is hidden so the
			footer stays pinned to the bottom.
		-->
		{#if collapsed}
			<div class="hidden flex-1 sm:block"></div>
		{/if}
		<nav class="mt-5 flex min-h-0 flex-1 flex-col {collapsed ? 'sm:hidden' : ''}">
			<h2 class="px-5 pb-1.5 text-[11px] font-medium uppercase tracking-wider text-fg-muted">
				Recents
			</h2>
			{#if data.conversations.length === 0}
				<p class="px-5 py-2 text-xs text-fg-muted">No conversations yet.</p>
			{:else}
				<ScrollPane class="min-h-0 flex-1 px-2" bind:scrollEl={recentsScrollEl}>
					<ul class="space-y-0.5">
						{#each data.conversations as c (c.id)}
							{@const href = `/chat/${c.id}`}
							{@const active = currentPath === href || pendingPath === href}
							{@const isRenaming = convUi.renamingId === c.id}
							<li class="group relative" animate:flip={flipParams}>
								{#if isRenaming}
									<!--
									Inline-edit affordance. We swap the anchor for
									an input bound to convUi.renameDraft; Enter commits,
									Esc cancels, blur-without-change cancels.
									Same padding/typography as the anchor so the
									row doesn't reflow when entering edit mode.
								-->
									<input
										type="text"
										bind:this={convUi.renameInputEl}
										bind:value={convUi.renameDraft}
										onkeydown={convUi.onRenameKey}
										onblur={convUi.commitRename}
										maxlength={MAX_CONVERSATION_TITLE_LENGTH}
										aria-label="Rename conversation"
										class="block w-full rounded-md border border-border-strong bg-surface-panel py-2 pl-3 pr-3 text-sm focus:border-border-focus focus:outline-none"
									/>
								{:else}
									<a
										{href}
										class="flex items-center gap-1.5 rounded-md py-2 pl-3 pr-8 text-sm transition active:bg-surface-sunken {active
											? 'bg-surface-sunken text-accent'
											: 'hover:bg-surface-sunken/70'}"
									>
										{#if isGenerating(c.id)}
											<!-- A generation is running for this conversation right
											 now (see $lib/generating-conversations). Takes the
											 leading slot ahead of both the title spinner and the
											 private mask: on a first exchange all three compete,
											 and "a response is coming" is the one worth the pixel.
											 A pulsing dot rather than a ring so it doesn't read as
											 a second title spinner. -->
											<span
												class="h-2 w-2 shrink-0 animate-pulse rounded-full bg-accent motion-reduce:animate-none"
												role="img"
												aria-label="Generating a response"
												title="Generating…"
											></span>
										{:else if isTitlePending(c.id)}
											<!-- Subtle spinner while the background auto-title
											 task is still generating this conversation's
											 title (see $lib/title-pending). -->
											<span
												class="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-border-focus border-t-transparent"
												aria-hidden="true"
												title="Generating title…"
											></span>
										{:else if c.private}
											<!-- Private (incognito) chat marker — a leading mask
											 glyph, mirroring the title-pending spinner's slot, so
											 sealed chats are recognizable at a glance in history. -->
											<VenetianMask
												size={14}
												strokeWidth={2.25}
												class="shrink-0 text-accent"
												aria-label="Private chat"
											/>
										{/if}
										<span class="min-w-0 truncate">{c.title ?? 'Untitled'}</span>
									</a>
									<DropdownMenu.Root
										open={openOverflowFor === c.id}
										onOpenChange={(o) => (openOverflowFor = o ? c.id : null)}
									>
										<DropdownMenu.Trigger
											disabled={convUi.busyId === c.id}
											title="Conversation options"
											aria-label="Options for conversation {c.title ?? 'Untitled'}"
											class="absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded border-0 bg-transparent text-fg-muted transition hover:bg-surface-sunken hover:text-fg-secondary focus-visible:opacity-100 disabled:opacity-50 can-hover:opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100"
										>
											<MoreVertical size={14} strokeWidth={2.25} />
										</DropdownMenu.Trigger>
										<DropdownMenu.Portal>
											<DropdownMenu.Content
												sideOffset={4}
												align="end"
												class="z-overlay min-w-[160px] overflow-hidden rounded-md border border-border surface-glass gs-pop py-1 shadow-lg"
											>
												<DropdownMenu.Item
													onSelect={() => convUi.startRename(c.id, c.title)}
													class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm transition data-[highlighted]:bg-surface-raised"
												>
													<Pencil size={14} strokeWidth={2.25} />
													<span>Rename</span>
												</DropdownMenu.Item>
												<DropdownMenu.Item
													onSelect={() => convUi.archive(c.id)}
													class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm transition data-[highlighted]:bg-surface-raised"
												>
													<Archive size={14} strokeWidth={2.25} />
													<span>Archive</span>
												</DropdownMenu.Item>
												<DropdownMenu.Item
													onSelect={() => convUi.requestDelete(c.id)}
													class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm text-danger transition data-[highlighted]:bg-danger/10"
												>
													<Trash2 size={14} strokeWidth={2.25} />
													<span>Delete</span>
												</DropdownMenu.Item>
											</DropdownMenu.Content>
										</DropdownMenu.Portal>
									</DropdownMenu.Root>
								{/if}
							</li>
						{/each}
					</ul>
				</ScrollPane>
			{/if}
		</nav>

		<!--
			Account menu: clicking the user's name opens a dropdown with
			account-scoped actions (Preferences, Logout). The bottom-of-
			sidebar identity area is the conventional home for account
			settings — matches ChatGPT / Claude.ai / Slack patterns — and
			leaves the top-level sidebar entries free for navigation
			destinations the user visits regularly. When collapsed on
			desktop, the trigger shrinks to a single User icon.

			The expanded trigger's asymmetric padding (pl-3 vs pr-1) is
			deliberate: this row sits in the sidebar's bottom-left corner,
			which in an iOS PWA is the *screen's* bottom-left corner, and
			the display's rounded mask eats ~20px of x at the name's
			baseline. env(safe-area-inset-left) doesn't help — it's 0 in
			portrait — so the clearance is a fixed nudge. 12 + 12 = 24px
			puts the first glyph clear of the curve (descenders included)
			while keeping the full-width tap target and hover surface,
			since the inset lives inside the trigger, not on the wrapper.
		-->
		<div class="mt-2 border-t border-border px-3 py-2 text-xs text-fg-muted">
			<DropdownMenu.Root bind:open={accountMenuOpen}>
				<DropdownMenu.Trigger
					class="flex w-full items-center gap-2 rounded transition hover:bg-surface-sunken hover:text-fg-secondary focus-visible:ring-1 focus-visible:ring-border-focus focus-visible:outline-none disabled:opacity-50 {collapsed
						? 'sm:justify-center'
						: 'justify-between pl-3 pr-1'} py-1"
					aria-label="Account menu"
					title={data.user.displayName ?? data.user.email ?? 'You'}
				>
					{#if !collapsed}
						<span class="truncate">{data.user.displayName ?? data.user.email ?? 'You'}</span>
						<ChevronDown size={12} strokeWidth={2.25} class="shrink-0 opacity-60" />
					{:else}
						<UserIcon size={14} strokeWidth={2.25} />
					{/if}
				</DropdownMenu.Trigger>
				<!--
					Dynamically imported on first open so the five menu items
					and their five lucide icons (Settings / Brain / Plug /
					ShieldCheck / LogOut) stay out of the layout chunk for
					sessions that never open this menu.
				-->
				{#if accountMenuOpen}
					{#await import('$lib/components/AccountMenuContent.svelte') then { default: AccountMenuContent }}
						<AccountMenuContent {goto} isAdmin={data.user.role === 'admin'} />
					{/await}
				{/if}
			</DropdownMenu.Root>
		</div>
	</aside>

	<!-- Main pane. Mobile gets a top bar with the hamburger; desktop hides
		 it because the sidebar is always visible there. The render wrapper
		 takes the remaining height (flex-1 min-h-0) so child pages whose
		 outer container is `h-full` don't overflow past the top bar. -->
	<main class="flex min-w-0 flex-1 flex-col overflow-hidden">
		<!-- Mobile top bar with the hamburger toggle. pt uses
			 max(env(safe-area-inset-top), default) so the iOS status bar in
			 PWA standalone doesn't overlap the tap target. sm:hidden so this
			 entire row only renders on mobile — desktop has the static
			 sidebar always visible. -->
		<div
			class="flex shrink-0 items-center gap-2 px-3 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))] sm:hidden"
		>
			<button
				type="button"
				onclick={() => (drawerOpen = true)}
				aria-label="Open menu"
				class="rounded-md p-1.5 transition hover:bg-surface-raised"
			>
				<Menu size={20} strokeWidth={2.25} />
			</button>
			<span class="text-sm font-semibold tracking-tight">GlyphStream</span>
			<!-- Private-chat control, shared with the hamburger row so it isn't
				 stranded on its own line (and, in an open chat, doesn't eat the
				 title's width). New-chat screen → an interactive toggle; an open
				 private chat → a read-only badge. Both published by the page via
				 privateView; the desktop equivalents live on the pages themselves. -->
			{#if privateView.toggleable}
				<button
					type="button"
					onclick={() => privateView.onToggle?.()}
					aria-pressed={privateView.active}
					aria-label={privateView.active ? 'Private chat on' : 'Start a private chat'}
					class="ml-auto flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition {privateView.active
						? 'border-transparent bg-accent text-accent-fg'
						: 'border-border text-fg-muted hover:bg-surface-raised hover:text-fg'}"
				>
					<VenetianMask size={14} strokeWidth={2.25} />
					<span>Private chat</span>
				</button>
			{:else if privateView.active}
				<span
					class="ml-auto flex items-center gap-1.5 rounded-full bg-accent/12 px-2.5 py-1 text-xs font-medium text-accent"
					title="Private chat — nothing from this chat is saved to memories, summaries, or search, and personalization / web / MCP tools are off"
				>
					<VenetianMask size={14} strokeWidth={2.25} />
					<span>Private</span>
				</span>
			{/if}
		</div>
		<div class="min-h-0 flex-1">
			{@render children()}
		</div>
	</main>
</div>

<!--
	Singleton toast surface for the authenticated app. Sits outside the
	flex root so its `fixed` positioning isn't accidentally clipped or
	constrained by any ancestor's overflow/transform. The component
	renders nothing when no toast is active.
-->
<Toaster />

<!--
	Shared delete-confirm dialog for the sidebar conversation list. It
	asks the question (and offers the orphan-media checkbox); the
	actual DELETE + post-delete navigation is performDelete() above.
	The same component backs the /archived list so both delete paths
	are identical.
-->
<DeleteConversationDialog bind:targetId={convUi.deleteTargetId} onconfirm={convUi.performDelete} />

<!--
	Host for the app-wide confirm dialog (confirmDialog.ask()). Like the
	Toaster it's a singleton surface rendered once here; gallery /
	custom-model / branch deletes drive it instead of window.confirm().
-->
<ConfirmDialog />

<!--
	"Stats for nerds". No affordance points at it — the only way in is
	double-activating the version number above.

	Dynamically imported for the same reasons as SearchModal below, only more
	so: this is the rarest surface in the app by construction, and it was the
	one being paid for on every load (12.8% of the layout chunk). The {#if}
	also keeps BaseDialog's window-keydown listener — which sits outside its
	own {#if open} — from being installed for the whole session.
-->
{#if debugOpen && DebugPanel}
	<DebugPanel open onClose={() => (debugOpen = false)} />
{/if}

<!--
	Host for the app-wide search modal (searchModal.show()). Sidebar
	Search button + the Cmd/Ctrl+K shortcut both feed this one surface.

	Dynamically imported on first open so the modal's code (+ its
	debounced /api/conversations/search fetcher) stays out of the layout
	critical path — most sessions never invoke search. The {#if} guard
	also means the modal's own window-Escape listener is only registered
	while open, which is when it's actually needed.
-->
{#if searchModal.open}
	{#await import('$lib/components/SearchModal.svelte') then { default: SearchModal }}
		<SearchModal />
	{/await}
{/if}

<svelte:window onkeydown={onGlobalKey} onfocus={refreshConversations} onpageshow={onPageShow} />
<svelte:document onvisibilitychange={onResumeVisibility} />
