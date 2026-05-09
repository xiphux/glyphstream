<script lang="ts">
	let { data } = $props();
</script>

<div class="mx-auto max-w-2xl px-6 py-16">
	<h1 class="text-3xl font-semibold tracking-tight">Welcome, {data.user.displayName ?? data.user.githubUsername}</h1>
	<p class="mt-3 text-neutral-600 dark:text-neutral-400">
		Chat is coming online next. Models endpoint live at <a class="underline" href="/api/models">/api/models</a>.
	</p>
</div>
