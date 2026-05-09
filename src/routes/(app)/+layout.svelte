<script lang="ts">
	let { data, children } = $props();
</script>

<div class="flex min-h-screen flex-col">
	<header
		class="flex items-center justify-between border-b border-neutral-200 bg-white px-4 py-3 dark:border-neutral-800 dark:bg-neutral-900"
	>
		<div class="flex items-center gap-2">
			<span class="font-semibold tracking-tight">GlyphStream</span>
		</div>
		<form method="POST" action="/api/auth/logout" class="flex items-center gap-3">
			<span class="hidden text-sm text-neutral-600 sm:inline dark:text-neutral-400">
				{data.user.displayName ?? data.user.githubUsername}
			</span>
			<button
				type="submit"
				class="rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-sm transition hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
			>
				Sign out
			</button>
		</form>
	</header>
	<main class="flex-1">
		{@render children()}
	</main>
</div>
