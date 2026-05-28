<!--
	Bottom composer: textarea + attachment strip + per-turn model picker +
	feature toggles + send/stop. Owns the composer-local concerns — textarea
	auto-resize, file-input, drag-drop drop zone, image paste — and emits
	send/stop/feature-change/favorite-toggle to the page, which holds the
	conversation state and the actual send logic.

	composerText + modelId are two-way bound so the page keeps the canonical
	draft + per-turn model selection.
-->
<script lang="ts">
	import { ArrowUp, Plus, Square } from '@lucide/svelte';
	import AttachmentThumbnails from '$lib/components/AttachmentThumbnails.svelte';
	import FeatureTogglesMenu from '$lib/components/FeatureTogglesMenu.svelte';
	import ModelPicker from '$lib/components/chat/ModelPicker.svelte';
	import { autoResizeTextarea, dragHasFiles, extractImageFiles } from '$lib/composer';
	import { composerEnterHandler } from '$lib/composer-keys';
	import type { AttachmentStore } from '$lib/attachments.svelte';
	import type { EnterBehavior, FeatureCategory, ModelEntry, ModelKind } from '$lib/types/api';

	interface Props {
		composerText: string;
		modelId: string;
		errorMsg: string | null;
		attachments: AttachmentStore;
		modelKind: ModelKind | null;
		disabledFeatures: FeatureCategory[];
		models: ModelEntry[];
		favoritedIds: string[];
		allowAttachments: boolean;
		hasValidModel: boolean;
		generating: boolean;
		/** True when a generation is in flight + cancellable (shows Stop). */
		canStop: boolean;
		enterBehavior: EnterBehavior;
		onSend: () => void;
		onStop: () => void;
		onFeaturesChange: (next: FeatureCategory[]) => void;
		onToggleFavorite: (id: string) => void;
	}

	let {
		composerText = $bindable(),
		modelId = $bindable(),
		errorMsg,
		attachments,
		modelKind,
		disabledFeatures,
		models,
		favoritedIds,
		allowAttachments,
		hasValidModel,
		generating,
		canStop,
		enterBehavior,
		onSend,
		onStop,
		onFeaturesChange,
		onToggleFavorite
	}: Props = $props();

	let textareaEl = $state<HTMLTextAreaElement | null>(null);
	let fileInputEl = $state<HTMLInputElement | null>(null);

	/** Lets the page land focus here on conversation-ready transitions
	 *  (entering a conversation, a finished stream). The page owns the
	 *  *when* (skip on touch / while generating); the textarea ref is
	 *  local, so the page calls this rather than holding the ref. */
	export function focus() {
		textareaEl?.focus();
	}

	// Auto-resize: grow with content up to a sensible max so long-form
	// composition gets room without pushing the message list off-screen.
	$effect(() => {
		const el = textareaEl;
		void composerText;
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

	function onSubmit(e: Event) {
		e.preventDefault();
		onSend();
	}

	const canSend = $derived(
		!((!composerText.trim() && attachments.items.length === 0) ||
			generating ||
			attachments.isBusy ||
			!hasValidModel)
	);
</script>

<form onsubmit={onSubmit} ondragenter={onDragEnter} ondragover={onDragOver} ondragleave={onDragLeave} ondrop={onDrop} class="relative mx-auto max-w-3xl">
	{#if errorMsg}
		<div
			class="mb-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200"
		>
			{errorMsg}
		</div>
	{/if}
	<div class="rounded-2xl border border-neutral-300 bg-white px-3 py-2 shadow-sm transition focus-within:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900 dark:focus-within:border-neutral-500">
		<AttachmentThumbnails {attachments} class="px-1" />
		<textarea
			bind:this={textareaEl}
			bind:value={composerText}
			rows="1"
			placeholder={modelKind === 'image' ? 'Describe an image to generate…' : 'Write a message…'}
			disabled={generating}
			onkeydown={composerEnterHandler(enterBehavior, () => onSend())}
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
					disabled={generating}
					aria-label="Attach image"
					title="Attach image"
					class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-700 disabled:opacity-30 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
				>
					<Plus size={18} strokeWidth={2.25} />
				</button>
			{/if}
			<FeatureTogglesMenu {disabledFeatures} disabled={generating} onChange={onFeaturesChange} />
			<div class="flex-1"></div>
			<!--
				Per-turn model picker: defaulted to the conversation's current
				model so the no-change case is invisible. Picking a different
				model rewrites the conversation's stored endpoint/model on the
				next send. Custom presets are intentionally NOT shown here —
				they bundle persona, and switching persona mid-thread is a
				different feature.
			-->
			<ModelPicker
				{models}
				bind:value={modelId}
				filterKinds={['chat', 'image', 'video']}
				disabled={generating}
				inline
				{favoritedIds}
				{onToggleFavorite}
			/>
			{#if canStop}
				<button
					type="button"
					onclick={onStop}
					aria-label="Stop generation"
					title="Stop"
					class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-red-600 text-white transition hover:bg-red-700 dark:bg-red-700 dark:hover:bg-red-600"
				>
					<Square size={14} strokeWidth={2.5} fill="currentColor" />
				</button>
			{:else}
				<button
					type="submit"
					disabled={!canSend}
					aria-label="Send message"
					title={!hasValidModel ? 'Pick a model to send' : 'Send'}
					class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-white transition hover:bg-neutral-800 disabled:opacity-30 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
				>
					<ArrowUp size={16} strokeWidth={2.5} />
				</button>
			{/if}
		</div>
	</div>
	{#if isDraggingOver}
		<!-- Drop-zone overlay — covers the form while a file drag is active.
			 pointer-events-none so the underlying drop event still fires. -->
		<div
			aria-hidden="true"
			class="pointer-events-none absolute inset-0 flex items-center justify-center rounded-2xl border-2 border-dashed border-neutral-500 bg-neutral-100/85 text-sm text-neutral-700 backdrop-blur-sm dark:border-neutral-400 dark:bg-neutral-900/85 dark:text-neutral-200"
		>
			Drop image to attach
		</div>
	{/if}
</form>
