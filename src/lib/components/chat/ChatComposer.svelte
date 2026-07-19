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
	import OfflineNotice from '$lib/components/chat/OfflineNotice.svelte';
	import SplitAttachmentsToggle from '$lib/components/chat/SplitAttachmentsToggle.svelte';
	import { stripSkillCommand } from '$lib/skill-command';
	import { imageAttachment } from '$lib/model-capabilities';
	import type { ImageAttachment } from '$lib/model-capabilities';
	import type { AttachmentStore } from '$lib/attachments.svelte';
	import {
		expandCompareSelections,
		resolveActiveModelKind,
		type CompareSelection,
	} from '$lib/fanout';
	import type {
		EnterBehavior,
		FeatureCategory,
		FeatureCategoryEntry,
		ModelEntry,
		ModelKind,
		SavedModelSet,
	} from '$lib/types/api';

	interface Props {
		composerText: string;
		modelId: string;
		errorMsg: string | null;
		attachments: AttachmentStore;
		modelKind: ModelKind | null;
		disabledFeatures: FeatureCategory[];
		featureCategories: readonly FeatureCategoryEntry[];
		/** Whether the conversation is a Private chat — locks the sealed feature
		 *  toggles off in the feature menu. */
		private?: boolean;
		models: ModelEntry[];
		/** The user's enabled skills, for the `/skill-name` autocomplete. */
		enabledSkills?: { id: string; name: string; description: string }[];
		favoritedIds: string[];
		allowAttachments: boolean;
		hasValidModel: boolean;
		generating: boolean;
		/** Browser reports no network. Blocks Send (the message stays in the box)
		 *  and surfaces the offline notice; the textarea stays editable. */
		offline?: boolean;
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
		/** The user's saved multi-model sets, surfaced in the picker's compare
		 *  controls for one-click re-apply. */
		modelSets: SavedModelSet[];
		/** Name of the custom-model preset this conversation was created from
		 *  (null when started from a plain base model). Lets the per-turn picker
		 *  keep showing the preset name while its base model is selected, instead
		 *  of appearing to switch off the persona on the first follow-up. */
		presetLabel?: string | null;
		/** Resolved base model id of the preset above, for the value match. */
		presetModelId?: string | null;
		onSend: () => void;
		onStop: () => void;
		onFeaturesChange: (next: FeatureCategory[]) => void;
		onToggleFavorite: (id: string) => void;
		onSaveModelSet: (name: string, selections: CompareSelection[]) => void;
		onDeleteModelSet: (id: string) => void;
	}

	let {
		composerText = $bindable(),
		modelId = $bindable(),
		errorMsg,
		attachments,
		modelKind,
		disabledFeatures,
		featureCategories,
		private: isPrivate = false,
		models,
		enabledSkills = [],
		favoritedIds,
		allowAttachments,
		hasValidModel,
		generating,
		offline = false,
		canStop,
		enterBehavior,
		compareSelections = $bindable(),
		compareMode = $bindable(),
		splitAttachments = $bindable(false),
		modelSets,
		presetLabel = null,
		presetModelId = null,
		onSend,
		onStop,
		onFeaturesChange,
		onToggleFavorite,
		onSaveModelSet,
		onDeleteModelSet,
	}: Props = $props();

	let coreRef = $state<{ focus: () => void } | null>(null);

	/** Delegates to ComposerCore's textarea focus — the page calls this on
	 *  conversation-ready transitions via bind:this. */
	export function focus() {
		coreRef?.focus();
	}

	// The ONE kind every kind-dependent control reads, so the single `modelKind`
	// prop and the compare cart can't drift the UI apart (placeholder, skills,
	// split, feature toggles). Reflects the compare cart's kind when a set is
	// active, else the conversation's `modelKind`. See resolveActiveModelKind.
	const fanoutModels = $derived(
		expandCompareSelections(compareSelections, (id) => {
			const m = models.find((x) => x.id === id);
			return m ? { displayName: m.displayName, modelKind: m.kind } : undefined;
		}),
	);
	const activeKind = $derived(
		resolveActiveModelKind(
			compareMode,
			fanoutModels.map((m) => m.modelKind),
			modelKind,
		),
	);

	// Placeholder tracks the active model's INPUT need, not just its kind — an
	// image-required model (I2I upscaler, image-to-video) can't act on a text
	// prompt, so "Describe an image to generate…" would be misleading. Once an
	// image is attached the ask flips to describing the edit.
	const activeAttachment = $derived.by<ImageAttachment>(() => {
		const m = models.find((x) => x.id === modelId);
		return m ? imageAttachment(m) : 'unknown';
	});
	const placeholder = $derived.by(() => {
		const hasImage = attachments.readyImageCount > 0;
		if (activeKind === 'image') {
			if (activeAttachment === 'required')
				return hasImage ? 'Describe the edit…' : 'Attach an image to edit…';
			return 'Describe an image to generate…';
		}
		if (activeKind === 'video') {
			if (activeAttachment === 'required')
				return hasImage ? 'Describe the video…' : 'Attach an image to animate…';
			return 'Describe a video to generate…';
		}
		return 'Write a message…';
	});

	// `/skill-name` autocomplete is offered only on chat models with the `skills`
	// category enabled for this conversation. Undefined → ComposerCore shows no
	// menu. The server re-validates regardless (model tool support, enabled set).
	const skillCommands = $derived(
		activeKind === 'chat' && !disabledFeatures.includes('skills') ? enabledSkills : undefined,
	);

	// The effective message after a leading `/skill-name` is stripped (when the
	// skill menu is active) — a bare command with no message isn't sendable.
	const effectiveText = $derived(
		skillCommands
			? stripSkillCommand(composerText.trim(), skillCommands).text
			: composerText.trim(),
	);
	// Image-input-only models (upscalers, background removal, image-to-video)
	// reject a text-only request upstream. When the active selection requires an
	// image and none is attached, block the send so the user learns before
	// committing a prompt rather than after an upstream failure. Absent
	// capabilities data reads as "unknown" (never `required`), so passthrough
	// models are unaffected. Compare mode gates on any required model in the cart.
	const needsImage = $derived.by(() => {
		if (attachments.readyImageCount > 0) return false;
		const ids = compareMode ? compareSelections.map((s) => s.modelId) : [modelId];
		return ids.some((id) => {
			const m = models.find((x) => x.id === id);
			return m ? imageAttachment(m) === 'required' : false;
		});
	});
	const canSend = $derived(
		!(
			(!effectiveText && attachments.items.length === 0) ||
			generating ||
			attachments.isBusy ||
			!hasValidModel ||
			offline ||
			needsImage
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
		(activeKind === 'image' || activeKind === 'video') && attachments.readyImageCount >= 2,
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
	{#if offline}
		<div class="mb-2">
			<OfflineNotice />
		</div>
	{/if}
	{#if needsImage && effectiveText}
		<!--
			The active model only accepts an image (upscaler / i2v / etc.) and none
			is attached — the send is already blocked (canSend). Surface the reason
			once the user has typed intent, so an untouched composer stays quiet.
		-->
		<div class="mb-2 rounded-md border px-3 py-2 text-xs alert-warning">
			This model needs an image — attach one to continue.
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
				modelKind={activeKind}
				disabled={generating}
				private={isPrivate}
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
				{modelSets}
				{onSaveModelSet}
				{onDeleteModelSet}
				{presetLabel}
				{presetModelId}
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
						: offline
							? "You're offline — reconnect to send"
							: needsImage
								? 'This model needs an image — attach one to continue'
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
