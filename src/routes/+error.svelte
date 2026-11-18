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
	//
	// A 5xx (Kit reports a failed fetch as 500) is usually transient — the
	// container restarting under a refocus, an iOS resume before the radio is
	// back — so the page also heals itself: it re-runs every load on `online`, on
	// an app resume, and on a capped backoff while visible. `refreshAll()` is
	// enough because Kit re-resolves the route from the URL the error page kept,
	// and a failing retry lands back on this same instance, which keeps the
	// backoff counting. A 4xx is a real answer and is left alone.
	import { onDestroy } from 'svelte';
	import { refreshAll } from '$app/navigation';
	import { page } from '$app/state';

	/** Delay before each automatic retry, in ms; the last one repeats. */
	const BACKOFF_MS = [2_000, 5_000, 15_000, 30_000];

	const transient = $derived(page.status >= 500);

	let attempt = 0;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let inFlight = false;
	let destroyed = false;

	function cancel() {
		if (timer) clearTimeout(timer);
		timer = null;
	}

	function schedule() {
		cancel();
		if (destroyed || !transient || document.visibilityState === 'hidden') return;
		const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
		attempt++;
		timer = setTimeout(() => void retry(), delay);
	}

	async function retry() {
		if (inFlight || destroyed || !transient) return;
		if (document.visibilityState === 'hidden') return;
		cancel();
		inFlight = true;
		try {
			await refreshAll();
		} catch {
			/* reported by landing back here */
		} finally {
			inFlight = false;
		}
		// A retry that recovered tore this component down, making this a no-op.
		schedule();
	}

	function onVisibilityChange() {
		if (document.visibilityState === 'hidden') cancel();
		else void retry();
	}

	function onPageShow(e: PageTransitionEvent) {
		if (e.persisted) void retry();
	}

	$effect(() => {
		if (transient) schedule();
	});

	onDestroy(() => {
		destroyed = true;
		cancel();
	});
</script>

<svelte:window ononline={() => void retry()} onpageshow={onPageShow} />
<svelte:document onvisibilitychange={onVisibilityChange} />

<div
	class="flex min-h-dvh flex-col items-center justify-center gap-3 bg-surface px-6 text-center text-fg"
>
	<p class="text-5xl font-semibold tracking-tight text-fg-muted">{page.status}</p>
	<p>{page.error?.message ?? 'Something went wrong.'}</p>
	{#if transient}
		<p class="text-sm text-fg-muted" role="status">Reconnecting…</p>
	{/if}
	<div class="mt-2 flex items-center gap-2">
		<button
			type="button"
			onclick={() => location.reload()}
			class="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg transition hover:opacity-90"
		>
			Reload
		</button>
		<a
			href={resolve('/(app)')}
			class="rounded-md border border-border px-3 py-1.5 text-sm font-medium transition hover:bg-surface-raised"
		>
			Back to GlyphStream
		</a>
	</div>
</div>
