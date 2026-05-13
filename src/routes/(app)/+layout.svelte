<script lang="ts">
	import { browser } from '$app/environment';
	import { untrack } from 'svelte';
	import { goto, invalidateAll } from '$app/navigation';
	import { navigating, page } from '$app/state';
	import { DropdownMenu } from 'bits-ui';
	import {
		Archive,
		Images,
		LogOut,
		Menu,
		MoreVertical,
		PanelLeftClose,
		PanelLeftOpen,
		Plus,
		Settings,
		SlidersHorizontal,
		Trash2
	} from 'lucide-svelte';

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
	// Two settings sub-pages: `customModelsActive` and `preferencesActive`
	// are specific so the sidebar highlights exactly one at a time when
	// the user is on either. A single `/settings`-prefix matcher would
	// light both entries up regardless of which page is shown.
	const customModelsActive = $derived(activeOrPending('/settings/models'));
	const preferencesActive = $derived(activeOrPending('/settings/preferences'));
	// "New chat" lives at /. Plain string equality (not startsWith) since
	// every path starts with '/' — would otherwise match every nav.
	const newChatPending = $derived(pendingPath === '/');

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
		try {
			const res = await fetch(`/api/conversations/${id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ archived: true })
			});
			if (!res.ok && res.status !== 404) {
				throw new Error(`Server returned ${res.status}`);
			}
			// If the archived conversation is the one currently open, leave the
			// user on /archived so the action's outcome is visible — otherwise
			// they'd just see the same chat with the conversation missing from
			// the sidebar, which feels broken.
			if (page.url.pathname === `/chat/${id}`) {
				await goto('/archived', { invalidateAll: true });
			} else {
				await invalidateAll();
			}
		} catch (e) {
			alert(`Couldn't archive conversation: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			busyId = null;
		}
	}

	async function deleteConversation(id: string) {
		if (busyId) return;
		if (!confirm('Delete this conversation? This cannot be undone.')) return;
		busyId = id;
		try {
			const res = await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
			if (!res.ok && res.status !== 404) {
				throw new Error(`Server returned ${res.status}`);
			}
			if (page.url.pathname === `/chat/${id}`) {
				await goto('/', { invalidateAll: true });
			} else {
				await invalidateAll();
			}
		} catch (e) {
			alert(`Couldn't delete conversation: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			busyId = null;
		}
	}
</script>

<div class="flex h-[100dvh] overflow-hidden">
	<!-- Mobile drawer backdrop. Pointer-events stay off when closed so it
		 doesn't intercept taps; the transition lets the fade animate. -->
	<button
		type="button"
		aria-label="Close menu"
		onclick={() => (drawerOpen = false)}
		class="fixed inset-0 z-30 bg-black/40 transition-opacity sm:hidden {drawerOpen
			? 'pointer-events-auto opacity-100'
			: 'pointer-events-none opacity-0'}"
	></button>

	<!-- Sidebar.
		 Mobile: fixed slide-in drawer toggled by drawerOpen — always w-64
		 when shown so chat titles remain readable.
		 Desktop (sm+): in-flow column whose width toggles via `collapsed`
		 between w-64 (full) and w-14 (icons only). The conversation list
		 + recents header hide entirely when collapsed; nav items show
		 just their lucide icons with `title` tooltips. -->
	<aside
		class="fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 flex-col overflow-x-hidden bg-neutral-50 transition-[transform,width] duration-200 sm:static sm:translate-x-0 dark:bg-neutral-900 {drawerOpen
			? 'translate-x-0'
			: '-translate-x-full sm:translate-x-0'} {collapsed ? 'sm:w-14' : 'sm:w-64'}"
	>
		<!-- Header row: title (when expanded) + collapse toggle (sm+ only).
			 pt uses max(env(safe-area-inset-top), default) so the title sits
			 below the iOS status bar in PWA standalone mode (viewport-fit=cover
			 + black-translucent status bar). Falls through to the default 1rem
			 on desktop / Android / mobile Safari where the inset is 0. -->
		<div class="flex items-center {collapsed ? 'justify-center' : 'justify-between'} px-3 pb-2 pt-[max(1rem,env(safe-area-inset-top))] sm:pl-4 sm:pt-4">
			{#if !collapsed}
				<a href="/" class="font-semibold tracking-tight">GlyphStream</a>
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
				href="/settings/preferences"
				title={collapsed ? 'Preferences' : ''}
				class="flex items-center gap-2.5 whitespace-nowrap rounded-md px-3 py-2 text-sm transition active:bg-neutral-300 dark:active:bg-neutral-700 {preferencesActive
					? 'bg-neutral-200 dark:bg-neutral-800'
					: 'hover:bg-neutral-200/70 dark:hover:bg-neutral-800'} {collapsed
					? 'sm:justify-center sm:px-0'
					: ''}"
			>
				<Settings size={16} strokeWidth={2.25} class="shrink-0" />
				{#if !collapsed}<span>Preferences</span>{/if}
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
			Conversation list. Hidden when collapsed (desktop); on mobile
			the drawer is always at w-64 so this always shows in the drawer.
			A spacer div fills the flex when the list is hidden so the
			footer stays pinned to the bottom.
		-->
		{#if collapsed}
			<div class="hidden flex-1 sm:block"></div>
		{/if}
		<nav class="mt-5 flex-1 overflow-y-auto px-2 {collapsed ? 'sm:hidden' : ''}">
			<h2 class="px-3 pb-1.5 text-[11px] font-medium uppercase tracking-wider text-neutral-500">
				Recents
			</h2>
			{#if data.conversations.length === 0}
				<p class="px-3 py-2 text-xs text-neutral-500">No conversations yet.</p>
			{:else}
				<ul class="space-y-0.5">
					{#each data.conversations as c (c.id)}
						{@const href = `/chat/${c.id}`}
						{@const active = currentPath === href || pendingPath === href}
						<li class="group relative">
							<a
								{href}
								class="block truncate rounded-md py-2 pl-3 pr-8 text-sm transition active:bg-neutral-300 dark:active:bg-neutral-700 {active
									? 'bg-neutral-200 dark:bg-neutral-800'
									: 'hover:bg-neutral-200/70 dark:hover:bg-neutral-800'}"
							>
								{c.title ?? 'Untitled'}
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
											onSelect={() => archiveConversation(c.id)}
											class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm transition data-[highlighted]:bg-neutral-100 dark:data-[highlighted]:bg-neutral-800"
										>
											<Archive size={14} strokeWidth={2.25} />
											<span>Archive</span>
										</DropdownMenu.Item>
										<DropdownMenu.Item
											onSelect={() => deleteConversation(c.id)}
											class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm text-red-600 transition data-[highlighted]:bg-red-50 dark:text-red-400 dark:data-[highlighted]:bg-red-950/40"
										>
											<Trash2 size={14} strokeWidth={2.25} />
											<span>Delete</span>
										</DropdownMenu.Item>
									</DropdownMenu.Content>
								</DropdownMenu.Portal>
							</DropdownMenu.Root>
						</li>
					{/each}
				</ul>
			{/if}
		</nav>

		<div class="mt-2 border-t border-neutral-200 px-3 py-2 text-xs text-neutral-500 dark:border-neutral-800">
			<form
				method="POST"
				action="/api/auth/logout"
				class="flex items-center gap-2 {collapsed ? 'sm:justify-center' : 'justify-between'}"
			>
				{#if !collapsed}
					<span class="truncate">{data.user.displayName ?? data.user.githubUsername}</span>
				{/if}
				<button
					type="submit"
					title="Sign out"
					aria-label="Sign out"
					class="flex h-6 w-6 items-center justify-center rounded transition hover:bg-neutral-200 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
				>
					<LogOut size={14} strokeWidth={2.25} />
				</button>
			</form>
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
