<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';

	let { data, children } = $props();

	const galleryActive = $derived(page.url.pathname.startsWith('/gallery'));
	const settingsActive = $derived(page.url.pathname.startsWith('/settings'));

	let deletingId = $state<string | null>(null);

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

<div class="flex h-screen overflow-hidden">
	<!-- Sidebar -->
	<aside
		class="hidden w-64 shrink-0 flex-col border-r border-neutral-200 bg-neutral-50 sm:flex dark:border-neutral-800 dark:bg-neutral-900"
	>
		<div class="flex items-center justify-between border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
			<a href="/" class="font-semibold tracking-tight">GlyphStream</a>
			<a
				href="/"
				class="rounded-md border border-neutral-200 bg-white px-2 py-1 text-xs transition hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
				title="Start a new chat"
			>
				+ New
			</a>
		</div>

		<div class="border-b border-neutral-200 px-2 py-2 dark:border-neutral-800">
			<a
				href="/gallery"
				class="block rounded-md px-3 py-2 text-sm transition {galleryActive
					? 'bg-neutral-200 dark:bg-neutral-800'
					: 'hover:bg-neutral-100 dark:hover:bg-neutral-800'}"
			>
				Gallery
			</a>
			<a
				href="/settings/models"
				class="block rounded-md px-3 py-2 text-sm transition {settingsActive
					? 'bg-neutral-200 dark:bg-neutral-800'
					: 'hover:bg-neutral-100 dark:hover:bg-neutral-800'}"
			>
				Custom models
			</a>
		</div>

		<nav class="flex-1 overflow-y-auto px-2 py-2">
			{#if data.conversations.length === 0}
				<p class="px-2 py-3 text-xs text-neutral-500">No conversations yet.</p>
			{:else}
				<ul class="space-y-0.5">
					{#each data.conversations as c (c.id)}
						{@const active = page.url.pathname === `/chat/${c.id}`}
						<li class="group relative">
							<a
								href="/chat/{c.id}"
								class="block truncate rounded-md py-2 pl-3 pr-8 text-sm transition {active
									? 'bg-neutral-200 dark:bg-neutral-800'
									: 'hover:bg-neutral-100 dark:hover:bg-neutral-800'}"
							>
								{c.title ?? 'Untitled'}
							</a>
							<button
								type="button"
								onclick={(ev) => deleteConversation(c.id, ev)}
								disabled={deletingId === c.id}
								title="Delete conversation"
								aria-label="Delete conversation {c.title ?? 'Untitled'}"
								class="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-xs text-neutral-500 opacity-0 transition group-hover:opacity-100 hover:bg-neutral-300 hover:text-red-700 disabled:opacity-50 dark:hover:bg-neutral-700 dark:hover:text-red-400"
							>
								{deletingId === c.id ? '…' : '×'}
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</nav>

		<div class="border-t border-neutral-200 px-3 py-2 text-xs text-neutral-500 dark:border-neutral-800">
			<form method="POST" action="/api/auth/logout" class="flex items-center justify-between">
				<span class="truncate">{data.user.displayName ?? data.user.githubUsername}</span>
				<button type="submit" class="underline transition hover:text-neutral-700 dark:hover:text-neutral-300">
					Sign out
				</button>
			</form>
		</div>
	</aside>

	<!-- Main pane -->
	<main class="flex flex-1 flex-col overflow-hidden">
		{@render children()}
	</main>
</div>
