<!--
	Shared composer input box used by both the chat-page composer
	(ChatComposer) and the new-chat home page. Owns the input mechanics
	that were duplicated across the two: the bordered box, attachment
	thumbnail strip, the textarea (auto-resize + Enter-to-submit + image
	paste), the attach button + hidden file input, and the drag-drop drop
	zone with its overlay.

	Page-specific controls — the model picker variant, feature toggles,
	and the send/stop button(s) — are injected via the `controls` snippet,
	which renders into the action row right after the attach button. The
	error banner, width wrapper, and submit logic stay with the consumer.

	`text` is two-way bound so the consumer keeps the canonical draft.
	The form's submit (button OR Enter) routes to `onSubmit`.
-->
<script lang="ts">
	import { type Snippet } from 'svelte';
	import { Plus } from '@lucide/svelte';
	import AttachmentThumbnails from '$lib/components/AttachmentThumbnails.svelte';
	import SkillMenu from '$lib/components/chat/SkillMenu.svelte';
	import SnippetAutocomplete from '$lib/components/chat/SnippetAutocomplete.svelte';
	import { autoResizeTextarea, dragHasFiles, extractImageFiles, replaceRange } from '$lib/composer';
	import { composerEnterHandler } from '$lib/composer-keys';
	import { filterSkillCommands, skillMenuQuery, type SkillCommandOption } from '$lib/skill-command';
	import { ATTACHMENT_ACCEPT, type AttachmentStore } from '$lib/attachments.svelte';
	import type { EnterBehavior, SnippetKind } from '$lib/types/api';

	interface SkillCommand extends SkillCommandOption {
		id: string;
		name: string;
		description: string;
	}

	interface Props {
		text: string;
		attachments: AttachmentStore;
		allowAttachments: boolean;
		disabled: boolean;
		placeholder: string;
		rows?: number;
		enterBehavior: EnterBehavior;
		/** Fired on form submit (Send button) OR Enter-to-send. */
		onSubmit: () => void;
		/** Trailing action-row controls: feature toggles, model picker,
		 *  send/stop. Rendered after the attach button. */
		controls: Snippet;
		/** Optional control rendered at the top-right of the attachment thumbnail
		 *  row (e.g. the split-attachments toggle), via AttachmentThumbnails'
		 *  `trailing` slot. The consumer decides when. */
		attachmentBar?: Snippet;
		/** Opt-in `/skill-name` autocomplete. The consumer passes the user's
		 *  ENABLED skills (already gated to `[]` when the conversation has the
		 *  `skills` category disabled or the model lacks tool support). Undefined
		 *  → no slash menu, behaving exactly as before (the home + chat composers
		 *  share this component). Selecting only completes the name into the box;
		 *  the consumer strips the leading `/name` on send via stripSkillCommand. */
		skillCommands?: SkillCommand[];
		/** Active model modality — filters the snippet autocomplete so image
		 *  styles don't clutter a text chat. Null disables the filter. */
		activeKind?: SnippetKind | null;
		/** Opt out of the `;` snippet autocomplete entirely. Defaults on: a
		 *  snippet is plain text with no payload cost, so there's nothing to
		 *  gate it behind the way skills need tool support. */
		allowSnippets?: boolean;
	}

	let {
		text = $bindable(),
		attachments,
		allowAttachments,
		disabled,
		placeholder,
		rows = 1,
		enterBehavior,
		onSubmit,
		controls,
		attachmentBar,
		skillCommands,
		activeKind = null,
		allowSnippets = true,
	}: Props = $props();

	let textareaEl = $state<HTMLTextAreaElement | null>(null);
	let fileInputEl = $state<HTMLInputElement | null>(null);
	let snippetMenu = $state<SnippetAutocomplete | null>(null);

	/** Focus the textarea. The consumer owns the *when* (e.g. on
	 *  conversation-ready, or autofocus on mount, skipping touch); the
	 *  textarea ref is local here, so the consumer calls this. */
	export function focus() {
		textareaEl?.focus();
	}

	// Auto-resize: grow with content up to a sensible max. Reacting to the
	// bound `text` means a consumer that sets text programmatically (e.g.
	// the gallery-launch prompt pickup) gets a correct resize post-flush
	// without a manual tick().
	$effect(() => {
		const el = textareaEl;
		void text;
		if (el) autoResizeTextarea(el);
	});

	// --- /skill-name autocomplete (opt-in via `skillCommands`) ---------------
	// The in-progress query (prefix after `/`, before any space), or null when
	// the draft isn't a leading slash command. Closes naturally once a space is
	// typed (the command is "locked in" and the user types the message).
	const skillQuery = $derived(skillCommands ? skillMenuQuery(text) : null);
	const filteredSkills = $derived(
		skillQuery !== null && skillCommands ? filterSkillCommands(skillCommands, skillQuery) : [],
	);
	let skillHighlight = $state(0);
	let skillMenuDismissed = $state(false);
	const skillMenuOpen = $derived(filteredSkills.length > 0 && !skillMenuDismissed);

	// Re-arm the menu + reset the highlight whenever the query value changes
	// (typing more of the name, clearing it). Escape sets `dismissed` within a
	// fixed query; this effect re-runs only when the query itself changes, so a
	// dismissal sticks until the user edits the command.
	$effect(() => {
		void skillQuery;
		skillMenuDismissed = false;
		skillHighlight = 0;
	});

	// Replaces the whole draft: the menu only opens when the entire box is a
	// bare `/query` (skillMenuQuery is anchored start-to-end), so there is
	// never surrounding text to preserve. Routed through replaceRange so the
	// completion lands on the native undo stack — one Ctrl-Z restores the
	// partial `/que` to re-pick, instead of the old `text = next` which wrote
	// past the undo stack entirely. insertText also leaves the caret at the
	// end and fires `input`, so the old tick()/setSelectionRange/resize dance
	// is no longer needed.
	function selectSkill(name: string) {
		const el = textareaEl;
		if (el) replaceRange(el, 0, text.length, `/${name} `);
	}

	/** Consume Arrow/Enter/Tab/Escape ONLY while the menu is open. Returns true
	 *  when handled (caller then skips the normal Enter-to-send handler). Never
	 *  steals IME-composition keys. */
	function handleSkillKey(e: KeyboardEvent): boolean {
		if (e.isComposing) return false;
		const n = filteredSkills.length;
		if (n === 0) return false;
		switch (e.key) {
			case 'ArrowDown':
				e.preventDefault();
				skillHighlight = (skillHighlight + 1) % n;
				return true;
			case 'ArrowUp':
				e.preventDefault();
				skillHighlight = (skillHighlight - 1 + n) % n;
				return true;
			case 'Enter':
			case 'Tab':
				// Selection ONLY completes the name — it never submits.
				e.preventDefault();
				selectSkill(filteredSkills[Math.min(skillHighlight, n - 1)].name);
				return true;
			case 'Escape':
				e.preventDefault();
				skillMenuDismissed = true;
				return true;
			default:
				return false;
		}
	}

	function onKeydown(e: KeyboardEvent) {
		// Skills first. The two menus can't actually both be open (see the
		// mutual-exclusivity note at the render site), so this ordering is
		// belt-and-braces rather than a real tiebreak.
		if (skillMenuOpen && handleSkillKey(e)) return;
		if (snippetMenu?.handleKeydown(e)) return;
		composerEnterHandler(enterBehavior, () => onSubmit())(e);
	}

	// Drag-drop drop zone. The counter pattern absorbs the recursive
	// enter/leave fired as the cursor crosses child elements.
	let isDraggingOver = $state(false);
	let dragDepth = 0;

	function onDragEnter(e: DragEvent) {
		if (!allowAttachments || !dragHasFiles(e)) return;
		e.preventDefault();
		dragDepth++;
		isDraggingOver = true;
	}

	function onDragOver(e: DragEvent) {
		if (!allowAttachments || !dragHasFiles(e)) return;
		// preventDefault on dragover is what enables drop.
		e.preventDefault();
	}

	function onDragLeave(e: DragEvent) {
		if (!allowAttachments || !dragHasFiles(e)) return;
		dragDepth = Math.max(0, dragDepth - 1);
		if (dragDepth === 0) isDraggingOver = false;
	}

	function onDrop(e: DragEvent) {
		if (!allowAttachments) return;
		e.preventDefault();
		dragDepth = 0;
		isDraggingOver = false;
		const files = extractImageFiles(e.dataTransfer);
		if (files.length > 0) void attachments.addFiles(files);
	}

	function onPaste(e: ClipboardEvent) {
		if (!allowAttachments) return;
		// Only swallow the paste when we consumed an image — plain-text
		// pastes fall through to the textarea so typing-flow isn't disrupted.
		const files = extractImageFiles(e.clipboardData);
		if (files.length > 0) {
			e.preventDefault();
			void attachments.addFiles(files);
		}
	}

	function handleSubmit(e: Event) {
		e.preventDefault();
		onSubmit();
	}
</script>

<form
	onsubmit={handleSubmit}
	ondragenter={onDragEnter}
	ondragover={onDragOver}
	ondragleave={onDragLeave}
	ondrop={onDrop}
	class="surface-glass-soft relative rounded-2xl border border-border-strong px-3 py-2 shadow-sm transition focus-within:border-border-focus"
>
	<!-- The two menus anchor at the same spot but are mutually exclusive by
	     construction: the snippet trigger requires start-of-word, so a `;` in
	     a `/skill` draft never matches. The {:else} makes that structural. -->
	{#if skillMenuOpen}
		<SkillMenu
			skills={filteredSkills}
			highlightedIndex={skillHighlight}
			onSelect={selectSkill}
			onHover={(i) => (skillHighlight = i)}
		/>
	{:else}
		<SnippetAutocomplete
			bind:this={snippetMenu}
			bind:text
			{textareaEl}
			{activeKind}
			enabled={allowSnippets}
		/>
	{/if}
	<AttachmentThumbnails {attachments} class="px-1" trailing={attachmentBar} />
	<textarea
		bind:this={textareaEl}
		bind:value={text}
		{rows}
		{placeholder}
		{disabled}
		onkeydown={onKeydown}
		onpaste={onPaste}
		class="block w-full resize-none border-0 bg-transparent px-2 py-2 text-base focus:outline-none disabled:opacity-50 sm:text-sm"
	></textarea>
	<div class="flex items-center gap-2 px-1 pt-1">
		{#if allowAttachments}
			<input
				bind:this={fileInputEl}
				type="file"
				accept={ATTACHMENT_ACCEPT}
				multiple
				class="hidden"
				onchange={(e) => {
					const t = e.currentTarget;
					if (t.files && t.files.length > 0) void attachments.addFiles(t.files);
					// Clear so re-picking the same file fires onchange again.
					t.value = '';
				}}
			/>
			<button
				type="button"
				onclick={() => fileInputEl?.click()}
				{disabled}
				aria-label="Attach file"
				title="Attach file"
				class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-fg-muted transition hover:bg-surface-raised hover:text-fg-secondary disabled:opacity-30"
			>
				<Plus size={18} strokeWidth={2.25} />
			</button>
		{/if}
		{@render controls()}
	</div>
	{#if isDraggingOver}
		<!-- Drop-zone overlay — covers the box while a file drag is active.
			 pointer-events-none so the underlying drop event still fires. -->
		<div
			aria-hidden="true"
			class="pointer-events-none absolute inset-0 flex items-center justify-center rounded-2xl border-2 border-dashed border-fg-muted bg-surface-panel/85 text-sm text-fg-secondary backdrop-blur-sm"
		>
			Drop image to attach
		</div>
	{/if}
</form>
