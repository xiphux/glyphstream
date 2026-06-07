<!--
	Spotlight-style search modal. Mounted once in the (app) layout; reads
	`searchModal.open` from the singleton store and renders an overlaid
	card with a search input and a results list.

	Same hand-rolled modal scaffold as ConfirmDialog (backdrop, surface-
	glass card, window-level Escape) — bits-ui's Dialog isn't pulled in
	just for this one surface.

	Result rows render the FTS5 snippet with {@html} so the `<mark>` tags
	wrap the matched terms. The snippet content is server-generated from
	FTS5's snippet() function over the *raw text* we feed the index (not
	the rendered HTML), and the only HTML it injects is the literal
	<mark>/</mark> pair we asked for — there's no user-controlled HTML
	path to worry about.
-->
<script lang="ts">
	import { goto } from '$app/navigation';
	import { Search as SearchIcon } from '@lucide/svelte';
	import { searchModal } from '$lib/search-modal.svelte';

	interface SearchResult {
		conversationId: string;
		conversationTitle: string | null;
		updatedAt: number;
		kind: 'message' | 'title';
		messageId: string | null;
		snippet: string;
	}

	const DEBOUNCE_MS = 250;

	let inputEl = $state<HTMLInputElement | null>(null);
	let query = $state('');
	let results = $state<SearchResult[]>([]);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let highlightedIdx = $state(0);

	let debounceTimer: ReturnType<typeof setTimeout> | null = null;
	let activeRequestId = 0;

	// On open: reset transient state and focus the input on the next
	// microtask (the <input> needs to be in the DOM first). On close:
	// drop any in-flight debounce so a late fire can't reopen state
	// we just cleared.
	$effect(() => {
		if (searchModal.open) {
			query = '';
			results = [];
			error = null;
			highlightedIdx = 0;
			queueMicrotask(() => inputEl?.focus());
		} else if (debounceTimer) {
			clearTimeout(debounceTimer);
			debounceTimer = null;
		}
	});

	function scheduleSearch() {
		if (debounceTimer) clearTimeout(debounceTimer);
		// Clearing the input is a "back to the empty-state hint" signal —
		// drop any pending fetch and stop the spinner immediately.
		if (!query.trim()) {
			results = [];
			error = null;
			loading = false;
			return;
		}
		// Non-empty query: flip the spinner on *now*, not 250ms from now
		// when the fetch actually fires. Otherwise the empty `results`
		// list reads as "No matches" during the debounce window —
		// indistinguishable from a real no-results outcome and confusing
		// enough to make the live-search feel broken. The spinner is the
		// signal that the user's keystroke has been received and a
		// search is coming.
		loading = true;
		debounceTimer = setTimeout(runSearch, DEBOUNCE_MS);
	}

	async function runSearch() {
		debounceTimer = null;
		const q = query.trim();
		if (!q) {
			results = [];
			error = null;
			loading = false;
			return;
		}
		const requestId = ++activeRequestId;
		error = null;
		try {
			const res = await fetch(`/api/conversations/search?q=${encodeURIComponent(q)}`);
			if (!res.ok) throw new Error(`Server returned ${res.status}`);
			const body = (await res.json()) as { results: SearchResult[] };
			// Drop a stale response if the user has typed further since we
			// fired (race: keystroke A starts, keystroke B starts, B
			// resolves first, A resolves last — we'd otherwise overwrite B's
			// results with A's).
			if (requestId !== activeRequestId) return;
			results = body.results;
			highlightedIdx = 0;
		} catch (e) {
			if (requestId !== activeRequestId) return;
			error = e instanceof Error ? e.message : 'Search failed';
			results = [];
		} finally {
			if (requestId === activeRequestId) loading = false;
		}
	}

	function activate(r: SearchResult) {
		// Close the modal *before* navigating so the route transition
		// doesn't fight an open overlay (the modal would unmount on a
		// layout-scope change anyway, but doing it explicitly avoids
		// the brief flash).
		searchModal.hide();
		const href =
			r.kind === 'message' && r.messageId
				? `/chat/${r.conversationId}#msg-${r.messageId}`
				: `/chat/${r.conversationId}`;
		void goto(href);
	}

	function onInput() {
		scheduleSearch();
	}

	// Window-level keyboard handling: Escape closes the modal whenever
	// it's open. Arrow keys + Enter only fire when the modal is open
	// AND we have results — they belong to the result-navigation flow.
	function onKey(e: KeyboardEvent) {
		if (!searchModal.open) return;
		if (e.key === 'Escape') {
			e.preventDefault();
			searchModal.hide();
			return;
		}
		if (results.length === 0) return;
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			highlightedIdx = (highlightedIdx + 1) % results.length;
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			highlightedIdx = (highlightedIdx - 1 + results.length) % results.length;
		} else if (e.key === 'Enter') {
			e.preventDefault();
			const r = results[highlightedIdx];
			if (r) activate(r);
		}
	}
</script>

<svelte:window onkeydown={onKey} />

{#if searchModal.open}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_interactive_supports_focus -->
	<div
		role="dialog"
		aria-modal="true"
		aria-label="Search chats"
		tabindex="-1"
		class="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-[10vh] backdrop-blur-sm"
		onclick={(e) => {
			if (e.target === e.currentTarget) searchModal.hide();
		}}
	>
		<div
			class="flex max-h-[80vh] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-border surface-glass gs-pop shadow-xl"
		>
			<!-- Input row -->
			<div class="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2.5">
				<SearchIcon size={16} strokeWidth={2.25} class="shrink-0 text-fg-muted" />
				<input
					bind:this={inputEl}
					bind:value={query}
					oninput={onInput}
					type="text"
					placeholder="Search your chats…"
					aria-label="Search query"
					class="min-w-0 flex-1 bg-transparent text-sm focus:outline-none"
				/>
				{#if loading}
					<span
						class="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-border-focus border-t-transparent"
						aria-label="Searching"
					></span>
				{/if}
			</div>

			<!-- Results / status -->
			<div class="min-h-0 flex-1 overflow-y-auto">
				{#if error}
					<p class="px-4 py-3 text-sm text-danger">{error}</p>
				{:else if query.trim() === ''}
					<p class="px-4 py-3 text-sm text-fg-muted">Search your chats by title or message.</p>
				{:else if results.length === 0 && !loading}
					<p class="px-4 py-3 text-sm text-fg-muted">No matches.</p>
				{:else}
					<ul class="py-1">
						{#each results as r, i (`${r.conversationId}:${r.messageId ?? 'title'}`)}
							{@const active = i === highlightedIdx}
							<li>
								<button
									type="button"
									onclick={() => activate(r)}
									onmouseenter={() => (highlightedIdx = i)}
									class="block w-full px-4 py-2 text-left transition {active
										? 'bg-surface-sunken'
										: 'hover:bg-surface-sunken/70'}"
								>
									<div class="truncate text-sm font-medium text-fg">
										{r.conversationTitle ?? 'Untitled'}
									</div>
									<!--
										FTS5 snippet — `<mark>` tags are the only HTML;
										style them via the inline class so search hits
										read as highlighted regardless of theme.
									-->
									<div
										class="mt-0.5 line-clamp-2 text-xs text-fg-muted [&_mark]:bg-amber-200 [&_mark]:text-fg [&_mark]:dark:bg-amber-500/30"
									>
										{@html r.snippet}
									</div>
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		</div>
	</div>
{/if}
