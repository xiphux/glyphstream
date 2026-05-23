<script lang="ts">
	import { browser } from '$app/environment';
	import { untrack } from 'svelte';
	import { goto, invalidateAll } from '$app/navigation';
	import { navigating, page } from '$app/state';
	import { DropdownMenu } from 'bits-ui';
	import Toaster from '$lib/components/Toaster.svelte';
	import DeleteConversationDialog from '$lib/components/DeleteConversationDialog.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import ScrollPane from '$lib/components/ScrollPane.svelte';
	import { toast } from '$lib/toast.svelte';
	import { errorMessageFromResponse } from '$lib/fetch-error';
	import { setArchived, deleteConversation } from '$lib/conversation-actions';
	import { isTitlePending } from '$lib/title-pending.svelte';
	import { MAX_CONVERSATION_TITLE_LENGTH } from '$lib/types/api';
	import {
		Archive,
		ChevronDown,
		Image as ImageIcon,
		Images,
		LogOut,
		Menu,
		MoreVertical,
		PanelLeftClose,
		PanelLeftOpen,
		Pencil,
		Plus,
		Settings,
		SlidersHorizontal,
		Sparkles,
		Trash2,
		User as UserIcon,
		Video as VideoIcon
	} from 'lucide-svelte';
	import type { ModelKind } from '$lib/types/api';
	import { tick } from 'svelte';

	let { data, children } = $props();

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
		const out: { value: string; label: string; kind: ModelKind }[] = [];
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

	let busyId = $state<string | null>(null);

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

	// Desktop collapse state. Only affects the sm+ static sidebar; the
	// mobile drawer always opens to the full width when toggled.
	// Persisted in localStorage so the user's preference survives reloads;
	// during SSR there's no localStorage so we default to expanded and
	// accept a brief width animation if the user had collapsed it.
	const COLLAPSE_KEY = 'glyphstream:sidebarCollapsed';
	let collapsed = $state(
		browser ? localStorage.getItem(COLLAPSE_KEY) === '1' : false
	);
	$effect(() => {
		if (browser) localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
	});

	$effect(() => {
		// Re-runs whenever the URL changes; collapse the mobile drawer.
		// (Reading currentPath here is what makes the effect track it.)
		void currentPath;
		// untrack the read so this effect's dep set stays as just
		// (currentPath). Otherwise dismissing the overflow menu would
		// itself trigger the close — we only want URL changes to do that.
		if (untrack(() => openOverflowFor) !== null) return;
		drawerOpen = false;
	});

	async function archiveConversation(id: string) {
		if (busyId) return;
		busyId = id;
		// Capture before any navigation so the Undo handler can decide
		// whether to bring the user back to where they were.
		const wasViewingChat = page.url.pathname === `/chat/${id}`;
		try {
			await setArchived(id, true);
			// Archive is "I'm done with this thread" in the same spirit
			// as delete — the user is signaling they want it out of
			// their immediate view. Mirror delete's behavior and send
			// them to the new-chat surface rather than pulling them
			// deeper into the archive. The toast below confirms the
			// action and offers Undo so a misclick is one tap to
			// recover instead of a trip through /archived.
			if (wasViewingChat) {
				await goto('/', { invalidateAll: true });
			} else {
				await invalidateAll();
			}
			toast.success('Conversation archived', {
				action: {
					label: 'Undo',
					handler: async () => {
						try {
							await setArchived(id, false);
							await invalidateAll();
							// Land the user back on the chat they were
							// viewing when they archived. If they were on
							// some other surface, leave them where they are.
							if (wasViewingChat) {
								await goto(`/chat/${id}`);
							}
						} catch (e) {
							toast.error(
								`Couldn't undo: ${e instanceof Error ? e.message : String(e)}`
							);
						}
					}
				}
			});
		} catch (e) {
			toast.error(
				`Couldn't archive conversation: ${e instanceof Error ? e.message : String(e)}`
			);
		} finally {
			busyId = null;
		}
	}

	// Delete flow: the conversation overflow menu's Delete item opens
	// the shared <DeleteConversationDialog> (rendered at the bottom of
	// this file). That component fetches the orphan-media counts,
	// renders the confirm modal — with the "also delete N images"
	// checkbox when there is media — and on confirm calls performDelete
	// below with the user's checkbox answer. The dialog only *asks*;
	// performDelete owns the actual DELETE because the post-delete
	// navigation here (bounce off /chat/:id) differs from the
	// archived list's.
	let deleteTargetId = $state<string | null>(null);

	function requestDelete(id: string) {
		// The sidebar is already pointer-events-none while busyId is
		// set; this guard is belt-and-suspenders against a stray click.
		if (busyId) return;
		deleteTargetId = id;
	}

	async function performDelete(id: string, deleteMedia: boolean) {
		if (busyId) return;
		busyId = id;
		try {
			await deleteConversation(id, deleteMedia);
			if (page.url.pathname === `/chat/${id}`) {
				await goto('/', { invalidateAll: true });
			} else {
				await invalidateAll();
			}
		} catch (e) {
			toast.error(
				`Couldn't delete conversation: ${e instanceof Error ? e.message : String(e)}`
			);
		} finally {
			busyId = null;
		}
	}

	// Inline rename state. `renamingId` is the conversation id currently
	// being edited; `renameDraft` is the working input value. We avoid
	// optimistic-update gymnastics (mutating the load prop) — Enter
	// fires the PATCH, closes the input, and invalidateAll() pulls the
	// fresh title in. Esc / blur-without-change bail out silently.
	let renamingId = $state<string | null>(null);
	let renameDraft = $state('');
	let renameInputEl = $state<HTMLInputElement | null>(null);
	let renameOriginal = $state('');

	async function startRename(id: string, currentTitle: string | null) {
		renamingId = id;
		renameOriginal = currentTitle ?? '';
		renameDraft = currentTitle ?? '';
		await tick();
		renameInputEl?.focus();
		renameInputEl?.select();
	}

	function cancelRename() {
		renamingId = null;
		renameDraft = '';
		renameOriginal = '';
	}

	async function commitRename() {
		if (!renamingId) return;
		const id = renamingId;
		const next = renameDraft.trim();
		// No-op exits: empty input (treat as cancel) and unchanged value.
		if (next.length === 0 || next === renameOriginal.trim()) {
			cancelRename();
			return;
		}
		// Optimistic-ish: close the input immediately so the UI feels
		// responsive even before the PATCH round-trip resolves. The text
		// shown in the sidebar reverts to the stale title until
		// invalidateAll() lands the new one — sub-300ms in practice.
		renamingId = null;
		renameDraft = '';
		renameOriginal = '';
		try {
			const res = await fetch(`/api/conversations/${id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ title: next })
			});
			if (!res.ok) {
				throw new Error(await errorMessageFromResponse(res));
			}
			await invalidateAll();
		} catch (e) {
			toast.error(
				`Couldn't rename conversation: ${e instanceof Error ? e.message : String(e)}`
			);
		}
	}

	function onRenameKey(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			void commitRename();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			cancelRename();
		}
	}
</script>

<div class="flex h-[100dvh] overflow-hidden">
	<!-- Mobile drawer backdrop. Pointer-events stay off when the drawer
		 is closed *or* when a conversation overflow menu is open. The
		 second case defends against an iOS Safari quirk: tapping the
		 overflow trigger inside the translated aside opens the menu via
		 a portal'd popover, and the browser-synthesized click that
		 follows the touch can end up dispatched to the z-30 backdrop
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
			if (openOverflowFor !== null) return;
			drawerOpen = false;
		}}
		class="fixed inset-0 z-30 bg-black/40 transition-opacity sm:hidden {drawerOpen
			? 'opacity-100'
			: 'opacity-0'} {drawerOpen && openOverflowFor === null
			? 'pointer-events-auto'
			: 'pointer-events-none'}"
	></button>

	<!-- Sidebar.
		 Mobile: fixed slide-in drawer toggled by drawerOpen — always w-64
		 when shown so chat titles remain readable.
		 Desktop (sm+): in-flow column whose width toggles via `collapsed`
		 between w-64 (full) and w-14 (icons only). The conversation list
		 + recents header hide entirely when collapsed; nav items show
		 just their lucide icons with `title` tooltips. -->
	<!--
		`busyId !== null` makes the entire sidebar inert while an
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
		class="fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 flex-col overflow-x-hidden bg-neutral-50 transition-[transform,width] duration-200 sm:static sm:translate-x-0 dark:bg-neutral-900 {drawerOpen
			? 'translate-x-0'
			: '-translate-x-full sm:translate-x-0'} {collapsed ? 'sm:w-14' : 'sm:w-64'} {busyId !== null
			? 'pointer-events-none'
			: ''}"
	>
		<!-- Header row: title (when expanded) + collapse toggle (sm+ only).
			 pt uses max(env(safe-area-inset-top), default) so the title sits
			 below the iOS status bar in PWA standalone mode (viewport-fit=cover
			 + black-translucent status bar). Falls through to the default 1rem
			 on desktop / Android / mobile Safari where the inset is 0. -->
		<div class="flex items-center {collapsed ? 'justify-center' : 'justify-between'} px-3 pb-2 pt-[max(1rem,env(safe-area-inset-top))] sm:pl-4 sm:pt-4">
			{#if !collapsed}
				<!-- Title + version pair. items-baseline so the smaller
					 version aligns to GlyphStream's baseline rather than
					 floating above it. Version stays muted and small —
					 "you have to be looking for it" affordance for confirming
					 a service-worker refresh or which build is loaded. -->
				<div class="flex items-baseline gap-1.5">
					<a href="/" class="font-semibold tracking-tight">GlyphStream</a>
					<span class="text-[10px] tabular-nums text-neutral-400 dark:text-neutral-600">
						v{__APP_VERSION__}
					</span>
				</div>
			{/if}
			<button
				type="button"
				onclick={() => (collapsed = !collapsed)}
				aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
				title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
				class="hidden h-7 w-7 items-center justify-center rounded text-neutral-500 transition hover:bg-neutral-200/70 hover:text-neutral-700 sm:flex dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
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
				href="/"
				class="flex items-center gap-2.5 whitespace-nowrap rounded-md px-3 py-2 text-sm transition active:bg-neutral-300 dark:active:bg-neutral-700 {newChatPending
					? 'bg-neutral-200 dark:bg-neutral-800'
					: 'hover:bg-neutral-200/70 dark:hover:bg-neutral-800'} {collapsed
					? 'sm:justify-center sm:px-0'
					: ''}"
				title={collapsed ? 'New chat' : 'Start a new chat'}
			>
				<Plus size={16} strokeWidth={2.25} class="shrink-0" />
				{#if !collapsed}<span>New chat</span>{/if}
			</a>
			<a
				href="/gallery"
				title={collapsed ? 'Gallery' : ''}
				class="flex items-center gap-2.5 whitespace-nowrap rounded-md px-3 py-2 text-sm transition active:bg-neutral-300 dark:active:bg-neutral-700 {galleryActive
					? 'bg-neutral-200 dark:bg-neutral-800'
					: 'hover:bg-neutral-200/70 dark:hover:bg-neutral-800'} {collapsed
					? 'sm:justify-center sm:px-0'
					: ''}"
			>
				<Images size={16} strokeWidth={2.25} class="shrink-0" />
				{#if !collapsed}<span>Gallery</span>{/if}
			</a>
			<a
				href="/settings/models"
				title={collapsed ? 'Custom models' : ''}
				class="flex items-center gap-2.5 whitespace-nowrap rounded-md px-3 py-2 text-sm transition active:bg-neutral-300 dark:active:bg-neutral-700 {customModelsActive
					? 'bg-neutral-200 dark:bg-neutral-800'
					: 'hover:bg-neutral-200/70 dark:hover:bg-neutral-800'} {collapsed
					? 'sm:justify-center sm:px-0'
					: ''}"
			>
				<SlidersHorizontal size={16} strokeWidth={2.25} class="shrink-0" />
				{#if !collapsed}<span>Custom models</span>{/if}
			</a>
			<a
				href="/archived"
				title={collapsed ? 'Archived' : ''}
				class="flex items-center gap-2.5 whitespace-nowrap rounded-md px-3 py-2 text-sm transition active:bg-neutral-300 dark:active:bg-neutral-700 {archivedActive
					? 'bg-neutral-200 dark:bg-neutral-800'
					: 'hover:bg-neutral-200/70 dark:hover:bg-neutral-800'} {collapsed
					? 'sm:justify-center sm:px-0'
					: ''}"
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
					<h2 class="px-5 pb-1 pt-1 text-[11px] font-medium uppercase tracking-wider text-neutral-500">
						Favorites
					</h2>
				{/if}
				<ScrollPane
					class="max-h-[30vh] px-2"
					bind:scrollEl={favScrollEl}
				>
					<ul class="space-y-0.5">
						{#each favoriteEntries as fav (fav.value)}
							<li>
								<a
									href="/?model={encodeURIComponent(fav.value)}"
									title={fav.label}
									class="flex items-center gap-2.5 whitespace-nowrap rounded-md px-3 py-2 text-sm transition hover:bg-neutral-200/70 active:bg-neutral-300 dark:hover:bg-neutral-800 dark:active:bg-neutral-700 {collapsed
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
										<ImageIcon size={16} strokeWidth={2.25} class="shrink-0 text-amber-500" />
									{:else if fav.kind === 'video'}
										<VideoIcon size={16} strokeWidth={2.25} class="shrink-0 text-amber-500" />
									{:else}
										<Sparkles size={16} strokeWidth={2.25} class="shrink-0 text-amber-500" />
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
			<h2 class="px-5 pb-1.5 text-[11px] font-medium uppercase tracking-wider text-neutral-500">
				Recents
			</h2>
			{#if data.conversations.length === 0}
				<p class="px-5 py-2 text-xs text-neutral-500">No conversations yet.</p>
			{:else}
				<ScrollPane
					class="min-h-0 flex-1 px-2"
					bind:scrollEl={recentsScrollEl}
				>
					<ul class="space-y-0.5">
					{#each data.conversations as c (c.id)}
						{@const href = `/chat/${c.id}`}
						{@const active = currentPath === href || pendingPath === href}
						{@const isRenaming = renamingId === c.id}
						<li class="group relative">
							{#if isRenaming}
								<!--
									Inline-edit affordance. We swap the anchor for
									an input bound to renameDraft; Enter commits,
									Esc cancels, blur-without-change cancels.
									Same padding/typography as the anchor so the
									row doesn't reflow when entering edit mode.
								-->
								<input
									type="text"
									bind:this={renameInputEl}
									bind:value={renameDraft}
									onkeydown={onRenameKey}
									onblur={commitRename}
									maxlength={MAX_CONVERSATION_TITLE_LENGTH}
									aria-label="Rename conversation"
									class="block w-full rounded-md border border-neutral-300 bg-white py-2 pl-3 pr-3 text-sm focus:border-neutral-500 focus:outline-none dark:border-neutral-600 dark:bg-neutral-800 dark:focus:border-neutral-400"
								/>
							{:else}
								<a
									{href}
									class="flex items-center gap-1.5 rounded-md py-2 pl-3 pr-8 text-sm transition active:bg-neutral-300 dark:active:bg-neutral-700 {active
										? 'bg-neutral-200 dark:bg-neutral-800'
										: 'hover:bg-neutral-200/70 dark:hover:bg-neutral-800'}"
								>
									{#if isTitlePending(c.id)}
										<!-- Subtle spinner while the background auto-title
											 task is still generating this conversation's
											 title (see $lib/title-pending). -->
										<span
											class="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-neutral-400 border-t-transparent dark:border-neutral-500 dark:border-t-transparent"
											aria-hidden="true"
											title="Generating title…"
										></span>
									{/if}
									<span class="min-w-0 truncate">{c.title ?? 'Untitled'}</span>
								</a>
								<DropdownMenu.Root
									open={openOverflowFor === c.id}
									onOpenChange={(o) => (openOverflowFor = o ? c.id : null)}
								>
									<DropdownMenu.Trigger
										disabled={busyId === c.id}
										title="Conversation options"
										aria-label="Options for conversation {c.title ?? 'Untitled'}"
										class="absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded border-0 bg-transparent text-neutral-500 transition hover:bg-neutral-300 hover:text-neutral-700 focus-visible:opacity-100 disabled:opacity-50 sm:opacity-0 sm:group-hover:opacity-100 dark:hover:bg-neutral-700 dark:hover:text-neutral-200 data-[state=open]:opacity-100"
									>
										<MoreVertical size={14} strokeWidth={2.25} />
									</DropdownMenu.Trigger>
									<DropdownMenu.Portal>
										<DropdownMenu.Content
											sideOffset={4}
											align="end"
											class="z-50 min-w-[160px] overflow-hidden rounded-md border border-neutral-200 bg-white py-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
										>
											<DropdownMenu.Item
												onSelect={() => startRename(c.id, c.title)}
												class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm transition data-[highlighted]:bg-neutral-100 dark:data-[highlighted]:bg-neutral-800"
											>
												<Pencil size={14} strokeWidth={2.25} />
												<span>Rename</span>
											</DropdownMenu.Item>
											<DropdownMenu.Item
												onSelect={() => archiveConversation(c.id)}
												class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm transition data-[highlighted]:bg-neutral-100 dark:data-[highlighted]:bg-neutral-800"
											>
												<Archive size={14} strokeWidth={2.25} />
												<span>Archive</span>
											</DropdownMenu.Item>
											<DropdownMenu.Item
												onSelect={() => requestDelete(c.id)}
												class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm text-red-600 transition data-[highlighted]:bg-red-50 dark:text-red-400 dark:data-[highlighted]:bg-red-950/40"
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
		-->
		<div class="mt-2 border-t border-neutral-200 px-3 py-2 text-xs text-neutral-500 dark:border-neutral-800">
			<DropdownMenu.Root>
				<DropdownMenu.Trigger
					class="flex w-full items-center gap-2 rounded transition hover:bg-neutral-200 hover:text-neutral-700 focus-visible:ring-1 focus-visible:ring-neutral-400 focus-visible:outline-none disabled:opacity-50 dark:hover:bg-neutral-800 dark:hover:text-neutral-300 {collapsed
						? 'sm:justify-center'
						: 'justify-between px-1'} py-1"
					aria-label="Account menu"
					title={data.user.displayName ?? data.user.githubUsername}
				>
					{#if !collapsed}
						<span class="truncate">{data.user.displayName ?? data.user.githubUsername}</span>
						<ChevronDown size={12} strokeWidth={2.25} class="shrink-0 opacity-60" />
					{:else}
						<UserIcon size={14} strokeWidth={2.25} />
					{/if}
				</DropdownMenu.Trigger>
				<DropdownMenu.Portal>
					<DropdownMenu.Content
						sideOffset={6}
						align="start"
						side="top"
						class="z-50 min-w-[180px] overflow-hidden rounded-md border border-neutral-200 bg-white py-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
					>
						<DropdownMenu.Item
							onSelect={() => goto('/settings/preferences')}
							class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm transition data-[highlighted]:bg-neutral-100 dark:data-[highlighted]:bg-neutral-800"
						>
							<Settings size={14} strokeWidth={2.25} />
							<span>Preferences</span>
						</DropdownMenu.Item>
						<DropdownMenu.Item
							onSelect={() => {
								// Form-submit semantics for logout: POST to the
								// session-clearing endpoint and follow its redirect.
								// Building a hidden form lets us reuse the existing
								// /api/auth/logout handler unchanged.
								const f = document.createElement('form');
								f.method = 'POST';
								f.action = '/api/auth/logout';
								document.body.appendChild(f);
								f.submit();
							}}
							class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm transition data-[highlighted]:bg-neutral-100 dark:data-[highlighted]:bg-neutral-800"
						>
							<LogOut size={14} strokeWidth={2.25} />
							<span>Sign out</span>
						</DropdownMenu.Item>
					</DropdownMenu.Content>
				</DropdownMenu.Portal>
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
		<div class="flex shrink-0 items-center gap-2 px-3 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))] sm:hidden">
			<button
				type="button"
				onclick={() => (drawerOpen = true)}
				aria-label="Open menu"
				class="rounded-md p-1.5 transition hover:bg-neutral-100 dark:hover:bg-neutral-800"
			>
				<Menu size={20} strokeWidth={2.25} />
			</button>
			<span class="text-sm font-semibold tracking-tight">GlyphStream</span>
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
<DeleteConversationDialog bind:targetId={deleteTargetId} onconfirm={performDelete} />

<!--
	Host for the app-wide confirm dialog (confirmDialog.ask()). Like the
	Toaster it's a singleton surface rendered once here; gallery /
	custom-model / branch deletes drive it instead of window.confirm().
-->
<ConfirmDialog />
