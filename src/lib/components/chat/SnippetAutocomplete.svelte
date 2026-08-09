<!--
	Prompt-snippet autocomplete controller. Owns the caret tracking, the
	derived query, highlight/dismissal state, and the insertion; renders
	SnippetMenu itself. Factored out (rather than inlined the way the skill
	menu is) because three separate textareas need it: the chat composer, the
	new-chat home composer, and the inline message editor.

	The host wires it up with two things:
	  1. `bind:this` so it can delegate keydown — `handleKeydown(e)` returns
	     true when it consumed the key.
	  2. `textareaEl` — the element to read the caret from and insert into.

	Caret tracking is the subtle part, and it is deliberately NOT the host's
	job. A `$derived` on `text` alone goes stale the moment the user *moves*
	the caret without editing (arrow keys, a click), so the caret has to be
	read from the element on several distinct events. This component attaches
	those listeners itself: requiring each host to wire four handlers correctly
	made the contract enforceable only by comment, and a host that missed one
	(`click` being the easiest to overlook) would silently filter against a
	stale position with no error and no failing test.
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
	/** The textarea's value at the moment `caret` was last read from it. */
	let caretValue = $state('');
	let highlight = $state(0);
	let dismissed = $state(false);

	/**
	 * The caret is only meaningful against the text it was measured in.
	 *
	 * Not every change to `text` comes with an event we can observe: the chat
	 * page swaps the draft programmatically on conversation switch, the gallery
	 * hands a prompt to the composer, an "undo" toast restores a previous
	 * draft. Those assign through `bind:value`, which does NOT dispatch `input`
	 * — so `caret` would keep indexing into text that is no longer there, and
	 * the menu could filter (or worse, `insert()` could splice) at a position
	 * that means something different now.
	 *
	 * Comparing against the value the caret was read from closes that: a
	 * programmatic swap leaves them mismatched and the menu simply stays shut
	 * until the next real interaction re-establishes both together.
	 */
	const query = $derived(enabled && text === caretValue ? snippetMenuQuery(text, caret) : null);

	// Track the caret ourselves rather than making it the host's contract. The
	// cleanup runs when `textareaEl` changes or the component unmounts.
	$effect(() => {
		const el = textareaEl;
		if (!el) return;
		const sync = () => {
			caret = el.selectionStart ?? 0;
			// Read the DOM value, not the `text` prop: within an `input` event the
			// prop may not have caught up yet, and it is the element's value the
			// caret actually indexes into.
			caretValue = el.value;
		};
		sync();
		for (const type of ['input', 'keyup', 'click', 'focus'] as const) {
			el.addEventListener(type, sync);
		}
		return () => {
			for (const type of ['input', 'keyup', 'click', 'focus'] as const) {
				el.removeEventListener(type, sync);
			}
		};
	});

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

	function insert(snippet: PromptSnippet): void {
		const el = textareaEl;
		const q = query;
		if (!el || !q) return;
		// Replace the trigger + partial query with the body, as one undo unit.
		// This fires a real `input` event, so the listener above resyncs both
		// the caret and the value it was measured against.
		replaceRange(el, q.start, caret, snippet.body);
		recordSnippetUse(snippet.id);
		dismissed = true;
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
		onHover={(i: number) => (highlight = i)}
	/>
{/if}
