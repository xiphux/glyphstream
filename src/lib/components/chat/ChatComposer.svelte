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
	import SplitAttachmentsToggle from '$lib/components/chat/SplitAttachmentsToggle.svelte';
	import { stripSkillCommand } from '$lib/skill-command';
	import type { AttachmentStore } from '$lib/attachments.svelte';
	import type { CompareSelection } from '$lib/fanout';
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
		/** The user's enabled skills, for the `/skill-name` autocomplete. */
		enabledSkills?: { id: string; name: string; description: string }[];
		favoritedIds: string[];
		allowAttachments: boolean;
		hasValidModel: boolean;
		generating: boolean;
		/** True when a generation is in flight + cancellable (shows Stop). */
		canStop: boolean;
		enterBehavior: EnterBehavior;
		/** Multi-model compare "cart" (model id → count), owned by the model
		 *  picker's compare mode. When non-empty, the next send fans the prompt
		 *  out to these instead of a single send. */
		compareSelections: CompareSelection[];
		/** Whether the picker is in compare mode. */
		compareMode: boolean;
		/** Split-attachments: fan the prompt out across the attached images. */
		splitAttachments?: boolean;
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
		enabledSkills = [],
		favoritedIds,
		allowAttachments,
		hasValidModel,
		generating,
		canStop,
		enterBehavior,
		compareSelections = $bindable(),
		compareMode = $bindable(),
		splitAttachments = $bindable(false),
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

	// `/skill-name` autocomplete is offered only on chat models with the `skills`
	// category enabled for this conversation. Undefined → ComposerCore shows no
	// menu. The server re-validates regardless (model tool support, enabled set).
	const skillCommands = $derived(
		modelKind === 'chat' && !disabledFeatures.includes('skills') ? enabledSkills : undefined,
	);

	// The effective message after a leading `/skill-name` is stripped (when the
	// skill menu is active) — a bare command with no message isn't sendable.
	const effectiveText = $derived(
		skillCommands
			? stripSkillCommand(composerText.trim(), skillCommands).text
			: composerText.trim(),
	);
	const canSend = $derived(
		!(
			(!effectiveText && attachments.items.length === 0) ||
			generating ||
			attachments.isBusy ||
			!hasValidModel
		),
	);

	// Total models in the comparison cart (sum of per-model counts). A real
	// comparison needs 2+; one model collapses to a normal single send.
	const compareTotal = $derived(compareSelections.reduce((n, s) => n + s.count, 0));
	const fanoutActive = $derived(compareMode && compareTotal >= 2);

	// Split-attachments is offered only for image/video models (which consume an
	// input image) with 2+ image attachments to fan across. Effective model
	// count feeds the cross-product total shown on the toggle.
	const canSplit = $derived(
		(modelKind === 'image' || modelKind === 'video') && attachments.readyImageCount >= 2,
	);
	const splitModelCount = $derived(fanoutActive ? compareTotal : 1);
	// Drop the flag the moment splitting stops being applicable, so a stale
	// toggle can't fan out a send it no longer fits.
	$effect(() => {
		if (!canSplit && splitAttachments) splitAttachments = false;
	});
</script>

<div class="relative mx-auto max-w-3xl">
	{#if errorMsg}
		<div class="mb-2 rounded-md border px-3 py-2 text-xs alert-danger">
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
		{skillCommands}
		onSubmit={onSend}
	>
		{#snippet attachmentBar()}
			{#if canSplit}
				<SplitAttachmentsToggle
					bind:enabled={splitAttachments}
					imageCount={attachments.readyImageCount}
					modelCount={splitModelCount}
					disabled={generating}
				/>
			{/if}
		{/snippet}
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
				switching persona mid-thread is a different feature. `allowCompare`
				adds the in-picker "Multiple" mode that drives the fan-out cart.
			-->
			<ModelPicker
				{models}
				bind:value={modelId}
				filterKinds={['chat', 'image', 'video']}
				disabled={generating}
				inline
				{favoritedIds}
				{onToggleFavorite}
				allowCompare
				bind:compareSelections
				bind:compareMode
			/>
			{#if canStop}
				<button
					type="button"
					onclick={onStop}
					aria-label="Stop generation"
					title="Stop"
					class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full btn-danger transition"
				>
					<Square size={14} strokeWidth={2.5} fill="currentColor" />
				</button>
			{:else}
				<button
					type="submit"
					disabled={!canSend}
					aria-label={fanoutActive ? `Send to ${compareTotal} models` : 'Send message'}
					title={!hasValidModel
						? 'Pick a model to send'
						: fanoutActive
							? `Send to ${compareTotal} models`
							: 'Send'}
					class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-inverse text-fg-inverse transition hover:opacity-90 disabled:opacity-30"
				>
					<ArrowUp size={16} strokeWidth={2.5} />
				</button>
			{/if}
		{/snippet}
	</ComposerCore>
</div>
