<!--
	Prompt-snippet autocomplete controller. Owns the caret tracking, the
	derived query, highlight/dismissal state, and the insertion; renders
	SnippetMenu itself. Factored out (rather than inlined the way the skill
	menu is) because three separate textareas need it: the chat composer, the
	new-chat home composer, and the inline message editor.

	The host wires it up with three things:
	  1. `bind:this` so it can delegate keydown  — `handleKeydown(e)` returns
	     true when it consumed the key.
	  2. `textareaEl` — the element to read the caret from and insert into.
	  3. `onSyncCaret` is NOT needed: the host calls `syncCaret()` from the
	     textarea's input/keyup/click/focus handlers.

	Caret tracking is the subtle part. A `$derived` on `text` alone would go
	stale the moment the user *moves* the caret without editing (arrow keys, a
	click), leaving the menu filtering against a position the user has left.
-->
<script lang="ts">
	import SnippetMenu from '$lib/components/chat/SnippetMenu.svelte';
	import { filterSnippets, snippetMenuQuery } from '$lib/prompt-snippet-trigger';
	import { ensureSnippetsLoaded, recordSnippetUse, snippetList } from '$lib/prompt-snippets.svelte';
	import { replaceRange } from '$lib/composer';
	import type { PromptSnippet, SnippetKind } from '$lib/types/api';

	interface Props {
		text: string;
		textareaEl: HTMLTextAreaElement | null;
		/** Active model modality; snippets tagged for other kinds are filtered
		 *  out. Null (no model resolved) disables filtering. */
		activeKind?: SnippetKind | null;
		/** Opt out entirely (e.g. a surface that shouldn't offer snippets). */
		enabled?: boolean;
	}

	let { text = $bindable(), textareaEl, activeKind = null, enabled = true }: Props = $props();

	let caret = $state(0);
	let highlight = $state(0);
	let dismissed = $state(false);

	const query = $derived(enabled ? snippetMenuQuery(text, caret) : null);

	// Kick the lazy fetch the first time a trigger is actually typed, so a
	// session that never uses snippets makes zero requests.
	$effect(() => {
		if (query !== null) void ensureSnippetsLoaded();
	});

	const filtered = $derived(
		query === null ? [] : filterSnippets(snippetList(), query.query, activeKind),
	);

	const open = $derived(filtered.length > 0 && !dismissed);

	// Re-arm the menu + reset the highlight whenever the query changes. Escape
	// sets `dismissed` within a fixed query; this re-runs only when the query
	// itself changes, so a dismissal sticks until the user edits the token.
	$effect(() => {
		void query?.query;
		void query?.start;
		dismissed = false;
		highlight = 0;
	});

	/** Pull the caret position off the textarea. The host calls this from the
	 *  textarea's input/keyup/click/focus handlers. */
	export function syncCaret(): void {
		caret = textareaEl?.selectionStart ?? 0;
	}

	export function isOpen(): boolean {
		return open;
	}

	function insert(snippet: PromptSnippet): void {
		const el = textareaEl;
		const q = query;
		if (!el || !q) return;
		// Replace the trigger + partial query with the body, as one undo unit.
		replaceRange(el, q.start, caret, snippet.body);
		recordSnippetUse(snippet.id);
		dismissed = true;
		// The insertion moved the caret; resync so the menu closes rather than
		// re-deriving against the pre-insert position.
		syncCaret();
	}

	/** Consume Arrow/Enter/Tab/Escape ONLY while the menu is open. Returns true
	 *  when handled, so the host skips its Enter-to-send handler. Never steals
	 *  IME-composition keys. */
	export function handleKeydown(e: KeyboardEvent): boolean {
		if (e.isComposing || !open) return false;
		const n = filtered.length;
		if (n === 0) return false;
		switch (e.key) {
			case 'ArrowDown':
				e.preventDefault();
				highlight = (highlight + 1) % n;
				return true;
			case 'ArrowUp':
				e.preventDefault();
				highlight = (highlight - 1 + n) % n;
				return true;
			case 'Enter':
			case 'Tab':
				// Selection ONLY inserts — it never submits.
				e.preventDefault();
				insert(filtered[Math.min(highlight, n - 1)]);
				return true;
			case 'Escape':
				e.preventDefault();
				dismissed = true;
				return true;
			default:
				return false;
		}
	}
</script>

{#if open}
	<SnippetMenu
		snippets={filtered}
		highlightedIndex={highlight}
		onSelect={insert}
		onHover={(i) => (highlight = i)}
	/>
{/if}
