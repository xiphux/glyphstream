<script lang="ts">
	// Errors thrown by a page load under (app) render here, inside the app
	// layout — so the sidebar (desktop) and the hamburger top bar (mobile)
	// stay reachable. Without this, SvelteKit's bare fallback error page took
	// over the whole viewport, which in a standalone PWA is a dead end: no
	// back button, no chrome, only a force-quit. The explicit home link is
	// the belt to that suspenders.
	import { page } from '$app/state';
</script>

<div class="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
	<p class="text-5xl font-semibold tracking-tight text-fg-muted">{page.status}</p>
	<p class="text-fg">{page.error?.message ?? 'Something went wrong.'}</p>
	<a
		href="/"
		class="mt-2 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg transition hover:opacity-90"
	>
		Back to GlyphStream
	</a>
</div>
