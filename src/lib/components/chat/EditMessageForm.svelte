<!--
	Inline message editor. Replaces a message bubble in-place while that
	message is being edited, so it's unambiguous which message you're
	changing. Save creates a new sibling under the edited message's
	parent (the page owns that logic via onSave); Cancel discards.

	Self-contained: owns its textarea ref + auto-resize, focuses on mount
	(mounting === edit-begin, since the page only renders this when
	editingMessageId matches), and handles its own attach/file-input.
	editText is two-way bound so the page keeps the canonical draft.
-->
<script lang="ts">
	import { tick } from 'svelte';
	import { Plus } from '@lucide/svelte';
	import AttachmentThumbnails from '$lib/components/AttachmentThumbnails.svelte';
	import { autoResizeTextarea } from '$lib/composer';
	import { composerEnterHandler } from '$lib/composer-keys';
	import type { AttachmentStore } from '$lib/attachments.svelte';
	import type { EnterBehavior } from '$lib/types/api';

	interface Props {
		editText: string;
		attachments: AttachmentStore;
		allowAttachments: boolean;
		enterBehavior: EnterBehavior;
		onSave: () => void;
		onCancel: () => void;
	}

	let {
		editText = $bindable(),
		attachments,
		allowAttachments,
		enterBehavior,
		onSave,
		onCancel
	}: Props = $props();

	let textareaEl = $state<HTMLTextAreaElement | null>(null);
	let fileInputEl = $state<HTMLInputElement | null>(null);

	// Auto-resize as the draft grows.
	$effect(() => {
		const el = textareaEl;
		void editText;
		if (el) autoResizeTextarea(el);
	});

	// Focus on mount — this component only exists while editing, so its
	// appearance is the edit-begin moment.
	$effect(() => {
		void tick().then(() => textareaEl?.focus());
	});

	const canSave = $derived(!(!editText.trim() && attachments.items.length === 0) && !attachments.isBusy);
</script>

<article
	class="ml-auto max-w-[85%] rounded-2xl border border-amber-300 bg-surface-panel p-3 shadow-sm dark:border-amber-800"
>
	<div class="mb-1 text-[11px] font-medium uppercase tracking-wider text-amber-700 dark:text-amber-400">
		Editing
	</div>
	<AttachmentThumbnails {attachments} class="mb-2" />
	<textarea
		bind:this={textareaEl}
		bind:value={editText}
		rows="1"
		onkeydown={(e) => {
			if (e.key === 'Escape') {
				e.preventDefault();
				onCancel();
				return;
			}
			composerEnterHandler(enterBehavior, () => onSave())(e);
		}}
		class="block w-full resize-none border-0 bg-transparent px-1 py-1 text-base focus:outline-none sm:text-sm"
	></textarea>
	<div class="mt-2 flex items-center gap-2">
		{#if allowAttachments}
			<input
				bind:this={fileInputEl}
				type="file"
				accept="image/*"
				multiple
				class="hidden"
				onchange={(e) => {
					const t = e.currentTarget;
					if (t.files && t.files.length > 0) {
						void attachments.addFiles(t.files);
					}
					t.value = '';
				}}
			/>
			<button
				type="button"
				onclick={() => fileInputEl?.click()}
				aria-label="Attach image"
				title="Attach image"
				class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-fg-muted transition hover:bg-surface-raised hover:text-fg-secondary"
			>
				<Plus size={18} strokeWidth={2.25} />
			</button>
		{/if}
		<div class="flex-1"></div>
		<button
			type="button"
			onclick={onCancel}
			class="rounded-md px-3 py-1.5 text-xs text-fg-secondary transition hover:bg-surface-raised"
		>
			Cancel
		</button>
		<button
			type="button"
			onclick={onSave}
			disabled={!canSave}
			class="rounded-md bg-surface-inverse px-3 py-1.5 text-xs text-fg-inverse transition hover:opacity-90 disabled:opacity-30"
		>
			Save
		</button>
	</div>
</article>
