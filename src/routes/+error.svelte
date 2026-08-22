<script lang="ts">
	import { resolve } from '$app/paths';
	// The LAST-resort error page, and deliberately not a copy of (app)/+error.svelte.
	//
	// That one renders inside the app layout, so the sidebar and top bar stay
	// reachable and a link home is enough. This one renders when the app layout
	// itself is gone: SvelteKit swaps the whole tree to [root_layout, root_error]
	// whenever a LAYOUT load fails — including a rejected `__data.json` from any
	// `invalidate()`, which `root.$set`s the result and cannot be caught. Without
	// a file here, Kit substitutes its own unstyled fallback, which in a
	// standalone PWA is the dead end (app)/+error.svelte's comment describes: no
	// back button, no chrome, only a force-quit.
	//
	// A reload rather than only a link, because the tree that a client-side
	// navigation would re-enter is the one that just failed — and on the layout's
	// deferred-payload fetch, the recovery paths it relies on (`online`, `focus`)
	// died with the component that registered them.
	import { page } from '$app/state';
</script>

<div
	class="flex min-h-dvh flex-col items-center justify-center gap-3 bg-surface px-6 text-center text-fg"
>
	<p class="text-5xl font-semibold tracking-tight text-fg-muted">{page.status}</p>
	<p>{page.error?.message ?? 'Something went wrong.'}</p>
	<div class="mt-2 flex items-center gap-2">
		<button
			type="button"
			onclick={() => location.reload()}
			class="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg transition hover:opacity-90"
		>
			Reload
		</button>
		<a
			href={resolve('/')}
			class="rounded-md border border-border px-3 py-1.5 text-sm font-medium transition hover:bg-surface-raised"
		>
			Back to GlyphStream
		</a>
	</div>
</div>
