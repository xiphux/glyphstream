<script lang="ts">
	import { page } from '$app/state';

	let { data, children } = $props();
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

		<nav class="flex-1 overflow-y-auto px-2 py-2">
			{#if data.conversations.length === 0}
				<p class="px-2 py-3 text-xs text-neutral-500">No conversations yet.</p>
			{:else}
				<ul class="space-y-0.5">
					{#each data.conversations as c (c.id)}
						{@const active = page.url.pathname === `/chat/${c.id}`}
						<li>
							<a
								href="/chat/{c.id}"
								class="block truncate rounded-md px-3 py-2 text-sm transition {active
									? 'bg-neutral-200 dark:bg-neutral-800'
									: 'hover:bg-neutral-100 dark:hover:bg-neutral-800'}"
							>
								{c.title ?? 'Untitled'}
							</a>
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
