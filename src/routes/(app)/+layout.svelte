<script lang="ts">
	import { browser } from '$app/environment';
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import {
		Images,
		LogOut,
		Menu,
		PanelLeftClose,
		PanelLeftOpen,
		Plus,
		SlidersHorizontal,
		X
	} from 'lucide-svelte';

	let { data, children } = $props();

	const galleryActive = $derived(page.url.pathname.startsWith('/gallery'));
	const settingsActive = $derived(page.url.pathname.startsWith('/settings'));
	const currentPath = $derived(page.url.pathname);

	let deletingId = $state<string | null>(null);

	// Mobile drawer state. The aside is `hidden ... sm:flex` on wide
	// viewports as before; on narrow viewports it slides in from the left
	// when this flag is true. Auto-closes on navigation so picking a
	// conversation doesn't leave the drawer covering the chat.
	let drawerOpen = $state(false);

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
		drawerOpen = false;
	});

	async function deleteConversation(id: string, ev: Event) {
		// The delete button lives inside the conversation's link, so without
		// preventDefault the click would also navigate into the chat we're
		// about to delete.
		ev.preventDefault();
		ev.stopPropagation();
		if (deletingId) return;
		if (!confirm('Delete this conversation? This cannot be undone.')) return;
		deletingId = id;
		try {
			const res = await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
			if (!res.ok && res.status !== 404) {
				throw new Error(`Server returned ${res.status}`);
			}
			// If the deleted conversation is the one currently displayed, send
			// the user home so they're not left looking at a 404 next render.
			// invalidateAll refreshes the layout's conversations list either way.
			if (page.url.pathname === `/chat/${id}`) {
				await goto('/', { invalidateAll: true });
			} else {
				await invalidateAll();
			}
		} catch (e) {
			alert(`Couldn't delete conversation: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			deletingId = null;
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
		class="fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 flex-col bg-neutral-50 transition-[transform,width] duration-200 sm:static sm:translate-x-0 dark:bg-neutral-900 {drawerOpen
			? 'translate-x-0'
			: '-translate-x-full sm:translate-x-0'} {collapsed ? 'sm:w-14' : 'sm:w-64'}"
	>
		<!-- Header row: title (when expanded) + collapse toggle (sm+ only). -->
		<div class="flex items-center {collapsed ? 'justify-center' : 'justify-between'} px-3 pt-4 pb-2 sm:pl-4">
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
				class="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition hover:bg-neutral-200/70 dark:hover:bg-neutral-800 {collapsed
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
				class="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition {galleryActive
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
				class="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition {settingsActive
					? 'bg-neutral-200 dark:bg-neutral-800'
					: 'hover:bg-neutral-200/70 dark:hover:bg-neutral-800'} {collapsed
					? 'sm:justify-center sm:px-0'
					: ''}"
			>
				<SlidersHorizontal size={16} strokeWidth={2.25} class="shrink-0" />
				{#if !collapsed}<span>Custom models</span>{/if}
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
						{@const active = page.url.pathname === `/chat/${c.id}`}
						<li class="group relative">
							<a
								href="/chat/{c.id}"
								class="block truncate rounded-md py-2 pl-3 pr-8 text-sm transition {active
									? 'bg-neutral-200 dark:bg-neutral-800'
									: 'hover:bg-neutral-200/70 dark:hover:bg-neutral-800'}"
							>
								{c.title ?? 'Untitled'}
							</a>
							<button
								type="button"
								onclick={(ev) => deleteConversation(c.id, ev)}
								disabled={deletingId === c.id}
								title="Delete conversation"
								aria-label="Delete conversation {c.title ?? 'Untitled'}"
								class="absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-neutral-500 opacity-100 transition hover:bg-neutral-300 hover:text-red-700 disabled:opacity-50 sm:opacity-0 sm:group-hover:opacity-100 dark:hover:bg-neutral-700 dark:hover:text-red-400"
							>
								<X size={14} strokeWidth={2.25} />
							</button>
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
		<div class="flex shrink-0 items-center gap-2 px-3 py-2 sm:hidden">
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
