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

	Also how a texting photo is developed (`purpose="photo"`): the marker's
	description as the prompt, and an aspect-ratio picker, since a photo is
	whatever shape the phone was held. Drawing with several models, either way,
	is a comparison the dialog then shows in place of the form (`comparison`):
	the same fan-out grid a media comparison has, each result as it lands, to
	pick the one to show. All of them are kept.
-->
<script lang="ts">
	import BaseDialog from '#lib/components/BaseDialog.svelte';
	import ModelPicker from './ModelPicker.svelte';
	import AspectRatioSelector from './AspectRatioSelector.svelte';
	import { agreedDefault, offeredRatios } from '#lib/aspect-ratio.js';
	import type { CompareSelection } from '#lib/fanout.js';
	import type { Snippet } from 'svelte';
	import type { ModelEntry } from '#lib/types/api.js';

	interface Props {
		open: boolean;
		/** Pre-filled from the source reply; the user may rewrite it entirely. */
		prompt: string;
		/** Image-kind models only. */
		models: ModelEntry[];
		/** Forwarded to the model picker — see its `loading`. */
		loading?: boolean;
		/**
		 * Forwarded to the model picker — see its `loadError`.
		 *
		 * Matters more here than anywhere else: this picker filters to image models,
		 * and the layout's first-paint seed carries none unless the user favourited
		 * one. A failed catalogue load therefore leaves the list genuinely empty, and
		 * without this it reads "No models available." — which is false.
		 */
		loadError?: boolean;
		modelId: string;
		/** The compare "cart" — model id → count. Picking more than one model
		 *  turns the draw into a side-by-side comparison. Bound so the page can
		 *  dispatch a draw per entry and reset it after. */
		compareSelections?: CompareSelection[];
		/** Whether the picker is in compare mode. Bound so the page can read it
		 *  (single draw vs comparison) and force it off. */
		compareMode?: boolean;
		/**
		 * Run the prompt through the image-prompt enhancer before generating.
		 *
		 * Offered here because it can't be reached anywhere else: the
		 * `image_prompt_enhancement` feature toggle is kind-scoped to image
		 * conversations (`featureCategoryAppliesToModelKind`), so in the chat
		 * conversation where an avatar gets drawn it never renders — leaving the
		 * enhancer permanently on with no way to say otherwise. It's usually
		 * wanted: the description is prose, and the enhancer restyles it into
		 * whatever the target model prefers. But a description the user has just
		 * hand-tuned is exactly the case for sending it verbatim.
		 */
		enhance: boolean;
		/** Non-null while the draw is on its way to the server — the dialog stays
		 *  up until it's accepted, so a refusal can be shown where it was asked. */
		status: string | null;
		onPromptChange: (value: string) => void;
		onEnhanceChange: (value: boolean) => void;
		onModelChange: (id: string) => void;
		onDraw: () => void;
		onCancel: () => void;
		/** What's being drawn — the avatar (default) or a texting photo. */
		purpose?: 'avatar' | 'photo';
		/** A photo's shape, or null for each model's default. Bindable; unused for
		 *  an avatar, which is always square. */
		aspectRatio?: string | null;
		/** A comparison under way: its grid, shown instead of the form. */
		comparison?: Snippet;
	}

	let {
		open,
		prompt,
		models,
		loading = false,
		loadError = false,
		modelId,
		compareSelections = $bindable([]),
		compareMode = $bindable(false),
		enhance,
		status,
		onPromptChange,
		onEnhanceChange,
		onModelChange,
		onDraw,
		onCancel,
		purpose = 'avatar',
		aspectRatio = $bindable(null),
		comparison,
	}: Props = $props();

	const isPhoto = $derived(purpose === 'photo');

	// The picker's compare mode is sticky — it stays on with one model in the
	// cart, which is a single draw wearing a comparison's clothes. Everything
	// downstream keys off "is this actually a comparison", not off the toggle.
	const compareTotal = $derived(compareSelections.reduce((n, s) => n + s.count, 0));
	const comparing = $derived(compareMode && compareTotal >= 2);

	// The shapes on offer are the selected models': all of them in a comparison
	// (each takes its nearest, server-side), else the one model.
	const selectedModels = $derived(
		comparing
			? models.filter((m) => compareSelections.some((s) => s.modelId === m.id))
			: models.filter((m) => m.id === modelId),
	);
	const ratioOptions = $derived(offeredRatios(selectedModels));
	const ratioDefault = $derived(agreedDefault(selectedModels));
	// Owned here rather than by the workflow: it only answers a detection in
	// this dialog's prompt, and the dialog remounts per open.
	let dismissedRatio = $state<string | null>(null);
	let ratioRef = $state<{ flushDetection(): void }>();

	function draw() {
		// The ratio the prompt names may still be inside the picker's debounce.
		ratioRef?.flushDetection();
		onDraw();
	}
</script>

<BaseDialog
	{open}
	onCancel={() => {
		// Dismissing mid-draw would strand a generation the user can't watch;
		// the request itself is unaffected, so just refuse to close.
		if (!status) onCancel();
	}}
	role="dialog"
	wide={!!comparison}
	titleId="avatar-draw-title"
	title={isPhoto ? 'Develop the photo' : 'Draw the avatar'}
>
	{#if comparison}
		<p class="mt-1 text-xs text-fg-muted">
			{#if isPhoto}
				Pick the one to show. The others are kept too — the arrows on the photo reach them.
			{:else}
				Pick the one to use as the avatar. The others are kept too — the arrows on the portrait
				reach them.
			{/if}
		</p>
		<div class="mt-3 max-h-[65vh] overflow-y-auto">
			{@render comparison()}
		</div>
		<div class="mt-4 flex justify-end">
			<button
				type="button"
				onclick={onCancel}
				class="rounded-md border border-border px-3 py-1.5 text-sm transition hover:bg-surface-sunken"
			>
				Done
			</button>
		</div>
	{:else}
		<p class="mt-1 text-xs text-fg-muted">
			{#if isPhoto}
				This is what gets sent to the image model — the photo as it was described.
			{:else}
				This is what gets sent to the image model. Trim anything the model said in character.
			{/if}
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
				{loading}
				{loadError}
				filterKinds={['image']}
				value={modelId}
				onChange={onModelChange}
				disabled={!!status}
				allowCompare
				bind:compareSelections
				bind:compareMode
			/>
			{#if comparing}
				<p class="mt-1 text-xs text-fg-muted">
					Each model draws its own version; you pick the one to keep.
				</p>
			{/if}
		</div>

		{#if isPhoto && ratioOptions.length > 0}
			<div class="mt-3 flex items-center gap-2">
				<span class="text-xs font-medium">Shape</span>
				<AspectRatioSelector
					bind:this={ratioRef}
					options={ratioOptions}
					defaultValue={ratioDefault}
					promptText={prompt}
					bind:value={aspectRatio}
					bind:dismissedRatio
					disabled={!!status}
				/>
			</div>
		{/if}

		<label class="mt-3 flex items-start gap-2 text-xs">
			<input
				type="checkbox"
				checked={enhance}
				disabled={!!status}
				onchange={(e) => onEnhanceChange(e.currentTarget.checked)}
				class="mt-0.5"
			/>
			<span>
				Rewrite for this model
				<span class="block text-fg-muted">
					Restyles the prompt into the model's preferred format. Turn off to send exactly what's
					above.
				</span>
			</span>
		</label>

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
				onclick={draw}
				disabled={!!status || !prompt.trim() || (!comparing && !modelId)}
				class="rounded-md bg-surface-inverse px-4 py-1.5 text-sm font-medium text-fg-inverse transition hover:opacity-90 disabled:opacity-50"
			>
				{#if status}
					{isPhoto ? 'Developing…' : 'Drawing…'}
				{:else if comparing}
					{isPhoto ? 'Develop' : 'Draw'} with {compareTotal} models
				{:else}
					{isPhoto ? 'Develop' : 'Draw'}
				{/if}
			</button>
		</div>
	{/if}
</BaseDialog>
