<!--
	Chat-page composer. Wraps the shared ComposerCore (textarea +
	attachments + drag-drop + paste mechanics) and supplies the chat-
	specific controls: per-turn model picker, feature toggles, and the
	Send/Stop button. The error banner + width wrapper live here (not in
	ComposerCore — they're consumer concerns).

	composerText + modelId are two-way bound so the page keeps the
	canonical draft + per-turn model selection.
-->
<script lang="ts">
	import { ArrowUp, Square } from '@lucide/svelte';
	import FeatureTogglesMenu from '$lib/components/FeatureTogglesMenu.svelte';
	import ModelPicker from '$lib/components/chat/ModelPicker.svelte';
	import ComposerCore from '$lib/components/chat/ComposerCore.svelte';
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

	let coreRef = $state<{ focus: () => void } | null>(null);

	/** Delegates to ComposerCore's textarea focus — the page calls this on
	 *  conversation-ready transitions via bind:this. */
	export function focus() {
		coreRef?.focus();
	}

	const placeholder = $derived(
		modelKind === 'image' ? 'Describe an image to generate…' : 'Write a message…'
	);

	const canSend = $derived(
		!((!composerText.trim() && attachments.items.length === 0) ||
			generating ||
			attachments.isBusy ||
			!hasValidModel)
	);
</script>

<div class="relative mx-auto max-w-3xl">
	{#if errorMsg}
		<div
			class="mb-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200"
		>
			{errorMsg}
		</div>
	{/if}
	<ComposerCore
		bind:this={coreRef}
		bind:text={composerText}
		{attachments}
		{allowAttachments}
		disabled={generating}
		{placeholder}
		{enterBehavior}
		onSubmit={onSend}
	>
		{#snippet controls()}
			<FeatureTogglesMenu {disabledFeatures} disabled={generating} onChange={onFeaturesChange} />
			<div class="flex-1"></div>
			<!--
				Per-turn model picker: defaulted to the conversation's current
				model so the no-change case is invisible. Custom presets are
				intentionally NOT shown here — they bundle persona, and
				switching persona mid-thread is a different feature.
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
					class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-inverse text-fg-inverse transition hover:opacity-90 disabled:opacity-30"
				>
					<ArrowUp size={16} strokeWidth={2.5} />
				</button>
			{/if}
		{/snippet}
	</ComposerCore>
</div>
