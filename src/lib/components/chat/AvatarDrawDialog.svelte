<!--
	Review-before-drawing: the image prompt, editable, plus the model to draw it
	with.

	Exists because the description doesn't always arrive clean. A roleplay model
	tends to answer in character first and comply second, so the reply can be a
	paragraph of prose followed by the actual description. `extractAvatarPrompt`
	recovers the tagged portion when the model cooperates; this is what covers
	the times it doesn't — and, more generally, lets a description be tightened
	before it costs a generation.

	A dialog rather than more of the popover menu: a popover dismisses on any
	outside click, which is a bad place to be editing a paragraph.
-->
<script lang="ts">
	import BaseDialog from '$lib/components/BaseDialog.svelte';
	import ModelPicker from './ModelPicker.svelte';
	import type { ModelEntry } from '$lib/types/api';

	interface Props {
		open: boolean;
		/** Pre-filled from the source reply; the user may rewrite it entirely. */
		prompt: string;
		/** Image-kind models only. */
		models: ModelEntry[];
		modelId: string;
		/** Non-null while drawing — the dialog stays up and reports progress
		 *  rather than closing on a request the user can't see the result of. */
		status: string | null;
		onPromptChange: (value: string) => void;
		onModelChange: (id: string) => void;
		onDraw: () => void;
		onCancel: () => void;
	}

	let {
		open,
		prompt,
		models,
		modelId,
		status,
		onPromptChange,
		onModelChange,
		onDraw,
		onCancel,
	}: Props = $props();
</script>

<BaseDialog
	{open}
	onCancel={() => {
		// Dismissing mid-draw would strand a generation the user can't watch;
		// the request itself is unaffected, so just refuse to close.
		if (!status) onCancel();
	}}
	role="dialog"
	titleId="avatar-draw-title"
	title="Draw the avatar"
>
	<p class="mt-1 text-xs text-fg-muted">
		This is what gets sent to the image model. Trim anything the model said in character.
	</p>

	<label class="mt-3 block text-xs font-medium" for="avatar-prompt">Image prompt</label>
	<textarea
		id="avatar-prompt"
		value={prompt}
		oninput={(e) => onPromptChange(e.currentTarget.value)}
		rows="6"
		disabled={!!status}
		class="mt-1 w-full resize-y rounded-md border border-border bg-surface-panel px-3 py-2 text-sm shadow-sm focus:border-border-focus focus:outline-none disabled:opacity-50"
	></textarea>

	<div class="mt-3">
		<span class="mb-1 block text-xs font-medium">Image model</span>
		<ModelPicker
			{models}
			filterKinds={['image']}
			value={modelId}
			onChange={onModelChange}
			disabled={!!status}
		/>
	</div>

	{#if status}
		<p class="mt-3 text-xs text-fg-secondary">{status}</p>
	{/if}

	<div class="mt-4 flex justify-end gap-2">
		<button
			type="button"
			onclick={onCancel}
			disabled={!!status}
			class="rounded-md border border-border px-3 py-1.5 text-sm transition hover:bg-surface-sunken disabled:opacity-50"
		>
			Cancel
		</button>
		<button
			type="button"
			onclick={onDraw}
			disabled={!!status || !prompt.trim() || !modelId}
			class="rounded-md bg-surface-inverse px-4 py-1.5 text-sm font-medium text-fg-inverse transition hover:opacity-90 disabled:opacity-50"
		>
			{status ? 'Drawing…' : 'Draw'}
		</button>
	</div>
</BaseDialog>
