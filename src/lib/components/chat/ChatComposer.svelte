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
	import { ArrowUp, Square, Columns3, X } from '@lucide/svelte';
	import FeatureTogglesMenu from '$lib/components/FeatureTogglesMenu.svelte';
	import ModelPicker from '$lib/components/chat/ModelPicker.svelte';
	import ComposerCore from '$lib/components/chat/ComposerCore.svelte';
	import type { AttachmentStore } from '$lib/attachments.svelte';
	import type { FanoutModel } from '$lib/fanout';
	import type {
		EnterBehavior,
		FeatureCategory,
		FeatureCategoryEntry,
		ModelEntry,
		ModelKind,
	} from '$lib/types/api';

	interface Props {
		composerText: string;
		modelId: string;
		errorMsg: string | null;
		attachments: AttachmentStore;
		modelKind: ModelKind | null;
		disabledFeatures: FeatureCategory[];
		featureCategories: readonly FeatureCategoryEntry[];
		models: ModelEntry[];
		favoritedIds: string[];
		allowAttachments: boolean;
		hasValidModel: boolean;
		generating: boolean;
		/** True when a generation is in flight + cancellable (shows Stop). */
		canStop: boolean;
		enterBehavior: EnterBehavior;
		/** Models queued for a multi-model fan-out comparison. When non-empty,
		 *  the next send fans the prompt out to these instead of a single send. */
		fanoutModels: FanoutModel[];
		/** Add the currently-picked model to the fan-out comparison. */
		onAddFanoutModel: () => void;
		/** Remove the fan-out model at this index. */
		onRemoveFanoutModel: (index: number) => void;
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
		featureCategories,
		models,
		favoritedIds,
		allowAttachments,
		hasValidModel,
		generating,
		canStop,
		enterBehavior,
		fanoutModels,
		onAddFanoutModel,
		onRemoveFanoutModel,
		onSend,
		onStop,
		onFeaturesChange,
		onToggleFavorite,
	}: Props = $props();

	let coreRef = $state<{ focus: () => void } | null>(null);

	/** Delegates to ComposerCore's textarea focus — the page calls this on
	 *  conversation-ready transitions via bind:this. */
	export function focus() {
		coreRef?.focus();
	}

	const placeholder = $derived(
		modelKind === 'image' ? 'Describe an image to generate…' : 'Write a message…',
	);

	const canSend = $derived(
		!(
			(!composerText.trim() && attachments.items.length === 0) ||
			generating ||
			attachments.isBusy ||
			!hasValidModel
		),
	);

	// Fan-out (multi-model compare) is text-only in this cut — image/video
	// fan-out is a later phase. The "+ Compare" affordance only shows for
	// chat models, and an in-progress comparison can't be extended.
	const canFanout = $derived(modelKind === 'chat');
	const fanoutActive = $derived(fanoutModels.length > 0);
</script>

<div class="relative mx-auto max-w-3xl">
	{#if errorMsg}
		<div
			class="mb-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200"
		>
			{errorMsg}
		</div>
	{/if}
	{#if fanoutActive}
		<div class="mb-2 flex flex-wrap items-center gap-1.5">
			<span class="text-[11px] font-medium uppercase tracking-wide text-fg-muted">Compare</span>
			{#each fanoutModels as fm, i (i)}
				<span
					class="inline-flex items-center gap-1 rounded-full border border-border bg-surface-raised px-2 py-0.5 text-xs text-fg-secondary"
				>
					<span class="max-w-[12rem] truncate" title={fm.displayName}>{fm.displayName}</span>
					<button
						type="button"
						onclick={() => onRemoveFanoutModel(i)}
						disabled={generating}
						aria-label="Remove {fm.displayName} from comparison"
						class="-mr-0.5 flex h-4 w-4 items-center justify-center rounded-full text-fg-muted transition hover:bg-surface-sunken hover:text-fg disabled:opacity-40"
					>
						<X size={11} strokeWidth={2.5} />
					</button>
				</span>
			{/each}
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
			<FeatureTogglesMenu
				{disabledFeatures}
				categories={featureCategories}
				disabled={generating}
				onChange={onFeaturesChange}
			/>
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
			{#if canFanout}
				<!--
					Add the currently-picked model to the comparison set. Click
					it once per model you want to compare (pick A → +, pick B →
					+, …); the next send fans the prompt out to all of them.
				-->
				<button
					type="button"
					onclick={onAddFanoutModel}
					disabled={generating}
					aria-label="Add this model to the comparison"
					title="Compare: send this prompt to multiple models at once"
					class="flex h-8 shrink-0 items-center gap-1 rounded-md px-2 text-xs text-fg-muted transition hover:bg-surface-raised focus:outline-none focus-visible:ring-1 focus-visible:ring-border-focus disabled:opacity-50"
				>
					<Columns3 size={14} />
					<span class="hidden sm:inline">Compare</span>
				</button>
			{/if}
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
					aria-label={fanoutActive ? `Send to ${fanoutModels.length} models` : 'Send message'}
					title={!hasValidModel
						? 'Pick a model to send'
						: fanoutActive
							? `Send to ${fanoutModels.length} models`
							: 'Send'}
					class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-inverse text-fg-inverse transition hover:opacity-90 disabled:opacity-30"
				>
					<ArrowUp size={16} strokeWidth={2.5} />
				</button>
			{/if}
		{/snippet}
	</ComposerCore>
</div>
