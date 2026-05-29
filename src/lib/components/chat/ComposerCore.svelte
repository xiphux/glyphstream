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
	import type { Snippet } from 'svelte';
	import { Plus } from '@lucide/svelte';
	import AttachmentThumbnails from '$lib/components/AttachmentThumbnails.svelte';
	import { autoResizeTextarea, dragHasFiles, extractImageFiles } from '$lib/composer';
	import { composerEnterHandler } from '$lib/composer-keys';
	import type { AttachmentStore } from '$lib/attachments.svelte';
	import type { EnterBehavior } from '$lib/types/api';

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
		controls
	}: Props = $props();

	let textareaEl = $state<HTMLTextAreaElement | null>(null);
	let fileInputEl = $state<HTMLInputElement | null>(null);

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
	<AttachmentThumbnails {attachments} class="px-1" />
	<textarea
		bind:this={textareaEl}
		bind:value={text}
		{rows}
		{placeholder}
		{disabled}
		onkeydown={composerEnterHandler(enterBehavior, () => onSubmit())}
		onpaste={onPaste}
		class="block w-full resize-none border-0 bg-transparent px-2 py-2 text-base focus:outline-none disabled:opacity-50 sm:text-sm"
	></textarea>
	<div class="flex items-center gap-2 px-1 pt-1">
		{#if allowAttachments}
			<input
				bind:this={fileInputEl}
				type="file"
				accept="image/*"
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
				aria-label="Attach image"
				title="Attach image"
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
			class="pointer-events-none absolute inset-0 flex items-center justify-center rounded-2xl border-2 border-dashed border-neutral-500 bg-neutral-100/85 text-sm text-fg-secondary backdrop-blur-sm dark:border-neutral-400 dark:bg-neutral-900/85"
		>
			Drop image to attach
		</div>
	{/if}
</form>
