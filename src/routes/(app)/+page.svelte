<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { ArrowUp } from '@lucide/svelte';
	import ModelPicker from '$lib/components/chat/ModelPicker.svelte';
	import FeatureTogglesMenu from '$lib/components/FeatureTogglesMenu.svelte';
	import ComposerCore from '$lib/components/chat/ComposerCore.svelte';
	import SplitAttachmentsToggle from '$lib/components/chat/SplitAttachmentsToggle.svelte';
	import { AttachmentStore, attachmentsAllowedFor } from '$lib/attachments.svelte';
	import { GALLERY_LAUNCH_KEY, type GalleryLaunchIntent } from '$lib/gallery-launch';
	import { expandCompareSelections, type CompareSelection, type FanoutModel } from '$lib/fanout';
	import type { CreateConversationRequest, FeatureCategory } from '$lib/types/api';
	import {
		composeGreeting,
		greetingContextKey,
		pickGreeting,
		preferredFirstName,
	} from '$lib/greeting';
	import { errorMessageFromResponse } from '$lib/fetch-error';
	import { toggleFavoriteModel } from '$lib/favorite-models';
	import { pendingFirstMessageKey, type PendingFirstMessage } from '$lib/pending-first-message';

	let { data } = $props();

	// Greeting is computed client-side so it reflects the user's local wall
	// clock (SSR would use the server's timezone). Each greeting is a template
	// with an optional `{name}` token that composeGreeting() fills in; before
	// hydration we fall back to a neutral one.
	//
	// Two triggers, two behaviors:
	//   - Mount → roll a fresh random line. A fresh mount happens both on a
	//     full reload and on a client-side nav back to this page (e.g. "New
	//     chat" from a thread), so revisiting the page gives you a new quote.
	//   - Refocus (tab refocus / resuming the PWA) → only re-roll if the line
	//     has gone stale, i.e. its context key no longer matches the current
	//     time/holiday. Switching away and back leaves a still-valid greeting
	//     untouched, so it doesn't churn — but a night line you return to in
	//     the morning gets refreshed.
	let greetingPick = $state({ greeting: 'Hello, {name}', key: '' });
	$effect(() => {
		greetingPick = pickGreeting(new Date());
		const onRefocus = () => {
			if (greetingContextKey(new Date()) !== greetingPick.key) {
				greetingPick = pickGreeting(new Date());
			}
		};
		const onVisibility = () => {
			if (document.visibilityState === 'visible') onRefocus();
		};
		document.addEventListener('visibilitychange', onVisibility);
		window.addEventListener('focus', onRefocus);
		return () => {
			document.removeEventListener('visibilitychange', onVisibility);
			window.removeEventListener('focus', onRefocus);
		};
	});
	const userFirstName = $derived(
		preferredFirstName(data.prefs?.name, data.user.displayName, data.user.email ?? 'You'),
	);
	const composedGreeting = $derived(composeGreeting(greetingPick.greeting, userFirstName));

	// Selection value mirrors what ModelPicker emits:
	//   - "endpointId::upstreamId"  → base model
	//   - "custom::{customModelId}" → saved preset
	let modelId = $state('');

	// Multi-model compare "cart" from the picker. When non-empty on send, the
	// first message fans out to these models instead of a single send.
	let compareSelections = $state<CompareSelection[]>([]);
	let compareMode = $state(false);
	let splitAttachments = $state(false);
	const fanoutFirstModels = $derived(
		expandCompareSelections(compareSelections, (id) => {
			const m = data.models.find((x) => x.id === id);
			return m ? { displayName: m.displayName, modelKind: m.kind } : undefined;
		}),
	);

	// Per-conversation feature opt-outs (see FEATURE_CATEGORIES). Transient
	// per page load — never persisted client-side, never restored across
	// visits. Defaulting to "all features on" every new chat is the privacy
	// posture we want: one accidental off-flip shouldn't quietly become
	// sticky across future sessions.
	let disabledFeatures = $state<FeatureCategory[]>([]);

	// Apply `?model=` from the URL whenever it changes. Sidebar favorites
	// link to `/?model=…`, and SvelteKit SPA-navigates between favorites
	// without remounting — so this needs to re-run on every URL change,
	// not just initial mount. The customModels/models lookup is untracked
	// so the effect's only dep is the URL value itself; otherwise a
	// `data.customModels` refresh would re-clobber a manually-picked
	// selection by re-applying whatever the URL param still said.
	$effect(() => {
		const urlModel = page.url.searchParams.get('model');
		if (!urlModel) return;
		untrack(() => {
			const isKnown = urlModel.startsWith('custom::')
				? data.customModels.some((m) => m.id === urlModel.slice('custom::'.length))
				: data.models.some((m) => m.id === urlModel);
			if (isKnown) modelId = urlModel;
		});
	});

	// Fallback default — fires when nothing else (URL param, gallery-launch
	// pickup) has set a model yet. Prefers the user's top favorite (the
	// first favorited model still resolvable to one of the kinds this
	// composer supports); falls back to "first chat-then-image-then-video
	// from the model list" if no favorite qualifies.
	$effect(() => {
		if (modelId) return;
		const favs = data.prefs?.favoriteModels ?? [];
		for (const fav of favs) {
			let baseKind: string | undefined;
			if (fav.startsWith('custom::')) {
				const cmId = fav.slice('custom::'.length);
				const cm = data.customModels.find((m) => m.id === cmId);
				if (!cm) continue;
				baseKind = data.models.find(
					(m) => m.id === `${cm.baseEndpointId}::${cm.baseModelId}`,
				)?.kind;
			} else {
				baseKind = data.models.find((m) => m.id === fav)?.kind;
			}
			if (baseKind === 'chat' || baseKind === 'image' || baseKind === 'video') {
				modelId = fav;
				return;
			}
		}
		modelId =
			data.models.find((m) => m.kind === 'chat')?.id ??
			data.models.find((m) => m.kind === 'image')?.id ??
			data.models.find((m) => m.kind === 'video')?.id ??
			'';
	});

	// Resolve the selection back to its underlying base ModelEntry so we
	// can keep the kind-aware placeholder/label behavior working for presets.
	const resolvedBase = $derived.by(() => {
		if (modelId.startsWith('custom::')) {
			const cmId = modelId.slice('custom::'.length);
			const cm = data.customModels.find((m) => m.id === cmId);
			if (!cm) return undefined;
			return data.models.find((m) => m.id === `${cm.baseEndpointId}::${cm.baseModelId}`);
		}
		return data.models.find((m) => m.id === modelId);
	});

	// Seed the feature-toggle state from the selected custom model's
	// defaults whenever the model selection changes. Base models reset to
	// [] (the global default). User toggles AFTER picking a model are
	// preserved because the effect only re-runs on modelId change, not on
	// toggle mutations or customModels list refreshes (the lookup is
	// untrack-wrapped). Switching to a different preset re-applies the
	// new preset's defaults — picking a new preset means adopting its
	// starting state.
	$effect(() => {
		const id = modelId;
		untrack(() => {
			if (id.startsWith('custom::')) {
				const cm = data.customModels.find((m) => m.id === id.slice('custom::'.length));
				disabledFeatures = cm ? [...cm.defaultDisabledFeatures] : [];
			} else {
				disabledFeatures = [];
			}
		});
	});
	const pickedKind = $derived(resolvedBase?.kind ?? 'chat');
	const composerPlaceholder = $derived(
		pickedKind === 'image'
			? 'Describe an image to generate…'
			: pickedKind === 'video'
				? 'Describe a video to generate…'
				: 'How can I help you today?',
	);

	let text = $state('');
	let busy = $state(false);
	let errorMsg = $state<string | null>(null);

	// Attachments are picked here and travel into the chat-id page via
	// sessionStorage along with the first-message text — the chat-id page
	// then forwards them to the message-send call.
	const attachments = new AttachmentStore();
	let coreRef = $state<{ focus: () => void } | null>(null);
	const allowAttachments = $derived(attachmentsAllowedFor(pickedKind));
	// Split-attachments availability + cross-product count (mirrors ChatComposer).
	const canSplit = $derived(
		(pickedKind === 'image' || pickedKind === 'video') && attachments.readyImageCount >= 2,
	);
	const splitModelCount = $derived(
		compareMode && fanoutFirstModels.length >= 2 ? fanoutFirstModels.length : 1,
	);
	$effect(() => {
		if (!canSplit && splitAttachments) splitAttachments = false;
	});
	onDestroy(() => attachments.destroy());

	// Pick up any pending gallery-launch intent stashed by MediaLightbox.
	// Consume-and-clear: the key is removed on first read so a back-
	// navigation or accidental remount can't re-trigger. SSR-safe
	// (sessionStorage doesn't exist on the server); the effect won't
	// pull anything until hydration runs.
	//
	// Reads of `data.models` happen inside `untrack` so a model-list
	// refresh doesn't re-run this effect — the intent is consumed once
	// at mount and that's it.
	$effect(() => {
		if (typeof window === 'undefined') return;
		const raw = window.sessionStorage.getItem(GALLERY_LAUNCH_KEY);
		if (!raw) return;
		window.sessionStorage.removeItem(GALLERY_LAUNCH_KEY);

		let intent: GalleryLaunchIntent;
		try {
			intent = JSON.parse(raw) as GalleryLaunchIntent;
		} catch {
			return;
		}

		untrack(() => {
			// Suggested model wins if it's actually available right now.
			// If the user removed the originating endpoint from config
			// since the media was generated, the lookup fails and we
			// fall through to the default-modelId effect's choice.
			if (intent.sourceModelId) {
				const found = data.models.find((m) => m.id === intent.sourceModelId);
				if (found) modelId = found.id;
			}

			if (intent.kind === 'regenerate') {
				// ComposerCore's own auto-resize $effect reacts to the bound
				// `text` change and runs post-DOM-flush, so it sizes to the
				// prompt without a manual tick()+resize dance here.
				text = intent.prompt;
			} else if (intent.kind === 'starting-image') {
				attachments.attachExisting(intent.mediaId);
			}
		});
	});

	// Autofocus the composer on load — typing a prompt to start a new
	// conversation is the entire purpose of this page, so the cursor
	// belongs in the box without a click or tab. Runs once on mount
	// (coreRef flips null→component a single time).
	//
	// Skipped on touch devices, where an unprompted focus springs the
	// on-screen keyboard open over the greeting.
	$effect(() => {
		if (window.matchMedia?.('(pointer: coarse)').matches) return;
		coreRef?.focus();
	});

	async function startChat() {
		// A multi-model first message uses the comparison cart (needs 2+);
		// otherwise the single picker selection. One compare model collapses to
		// a normal single send on that model.
		const fanout = compareMode && fanoutFirstModels.length >= 2 ? fanoutFirstModels : null;
		const singleCompareModel =
			compareMode && fanoutFirstModels.length === 1 ? fanoutFirstModels[0].modelId : null;
		const effectiveModelId = singleCompareModel ?? modelId;
		if ((!fanout && !effectiveModelId) || busy) return;
		if (!text.trim() && attachments.items.length === 0) return;
		if (attachments.isBusy) return;
		busy = true;
		errorMsg = null;
		try {
			// Build the create request based on what the picker selected. For
			// presets we send `customModelId` and let the server resolve the
			// base model + system prompt + parameters from the stored row. For
			// a fan-out, the conversation is created on the first comparison
			// model (its stored default for any later single-model turns); each
			// branch overrides the model per-message anyway.
			let createBody: CreateConversationRequest;
			if (fanout) {
				createBody = { modelId: fanout[0].modelId, modelKind: fanout[0].modelKind };
			} else if (singleCompareModel) {
				createBody = { modelId: singleCompareModel, modelKind: 'chat' };
			} else if (modelId.startsWith('custom::')) {
				createBody = {
					customModelId: modelId.slice('custom::'.length),
					modelKind: resolvedBase?.kind,
				};
			} else {
				createBody = { modelId, modelKind: resolvedBase?.kind };
			}
			if (disabledFeatures.length > 0) {
				createBody.disabledFeatures = [...disabledFeatures];
			}
			const createRes = await fetch('/api/conversations', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(createBody),
			});
			if (!createRes.ok) {
				throw new Error(await errorMessageFromResponse(createRes));
			}
			const { conversation } = (await createRes.json()) as {
				conversation: { id: string };
			};

			// Hand the first message off to the chat page so the streaming
			// response renders inside the right route lifecycle. Stash in
			// sessionStorage (per-conversation key) and navigate. Payload is
			// JSON-encoded so we can carry attached media ids (and, for a
			// fan-out, the model set) alongside the text.
			const splitImageIds =
				splitAttachments && attachments.readyImageCount >= 2
					? attachments.readyImageMediaIds()
					: null;
			window.sessionStorage.setItem(
				pendingFirstMessageKey(conversation.id),
				JSON.stringify({
					text,
					attachedMediaIds: attachments.readyMediaIds(),
					...(fanout ? { fanoutModels: fanout } : {}),
					...(splitImageIds ? { splitImageIds } : {}),
				} satisfies PendingFirstMessage),
			);
			attachments.clear();
			await goto(`/chat/${conversation.id}`, { invalidateAll: true });
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}
</script>

<div class="flex h-full flex-col items-center justify-center px-4 py-8">
	<div class="w-full max-w-2xl">
		<!--
			Greeting block: glyph mark inside a soft circular badge, then
			"Good evening, Chris" line. The badge wrapper grounds the mark
			against the page bg the same way the composer below does, with
			a subtle ring + slightly raised bg shade. Mark is inlined (not
			<img>) so its strokes use currentColor and adapt to dark mode.
		-->
		<div class="mb-6 flex flex-col items-center gap-4">
			<div
				class="flex h-16 w-16 items-center justify-center rounded-full bg-surface-raised ring-1 ring-border"
			>
				<svg
					viewBox="0 0 32 32"
					class="h-8 w-8 text-accent"
					fill="none"
					stroke="currentColor"
					stroke-width="2.5"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<line x1="10.6" y1="7.5" x2="10.6" y2="24.5" />
					<path d="M 10.6 10 C 20 10, 22.5 18.5, 13.75 18.5" />
					<line x1="15" y1="22.75" x2="22.25" y2="22.75" />
				</svg>
			</div>
			{#if data.prefs?.showGreeting ?? true}
				<h1 class="text-center text-3xl font-semibold tracking-tight sm:text-4xl">
					<span class="text-fg">{composedGreeting}</span>
				</h1>
			{/if}
		</div>

		<ComposerCore
			bind:this={coreRef}
			bind:text
			{attachments}
			{allowAttachments}
			disabled={busy}
			placeholder={composerPlaceholder}
			rows={2}
			enterBehavior={data.prefs?.enterBehavior ?? 'send'}
			onSubmit={startChat}
		>
			{#snippet attachmentBar()}
				{#if canSplit}
					<SplitAttachmentsToggle
						bind:enabled={splitAttachments}
						imageCount={attachments.readyImageCount}
						modelCount={splitModelCount}
						disabled={busy}
					/>
				{/if}
			{/snippet}
			{#snippet controls()}
				<FeatureTogglesMenu
					{disabledFeatures}
					categories={data.featureCategories}
					disabled={busy}
					onChange={(next) => (disabledFeatures = next)}
				/>
				<div class="flex-1"></div>
				<!--
					Inline model selector: rendered as a borderless dropdown so
					it reads as a soft control inside the box. Presets ARE shown
					here (unlike the per-turn chat picker) since starting a new
					chat from a saved persona is a primary entry point.
				-->
				<ModelPicker
					models={data.models}
					customModels={data.customModels}
					bind:value={modelId}
					filterKinds={['chat', 'image', 'video']}
					disabled={busy}
					inline
					favoritedIds={data.prefs?.favoriteModels ?? []}
					onToggleFavorite={(id) => void toggleFavoriteModel(data.prefs?.favoriteModels ?? [], id)}
					allowCompare
					bind:compareSelections
					bind:compareMode
				/>
				<button
					type="submit"
					disabled={(compareMode && fanoutFirstModels.length > 0 ? false : !modelId) ||
						(!text.trim() && attachments.items.length === 0) ||
						busy ||
						attachments.isBusy}
					aria-label={compareMode && fanoutFirstModels.length > 0
						? `Send to ${fanoutFirstModels.length} models`
						: 'Send message'}
					title={compareMode && fanoutFirstModels.length > 0
						? `Send to ${fanoutFirstModels.length} models`
						: 'Send'}
					class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-inverse text-fg-inverse transition hover:opacity-90 disabled:opacity-30"
				>
					<ArrowUp size={16} strokeWidth={2.5} />
				</button>
			{/snippet}
		</ComposerCore>

		{#if data.models.length === 0}
			<p class="mt-3 text-center text-xs text-warning">
				No models available — check <code>config.toml</code> and your endpoints.
			</p>
		{/if}

		{#if errorMsg}
			<div class="mt-3 rounded-md border px-3 py-2 text-sm alert-danger">
				{errorMsg}
			</div>
		{/if}
	</div>
</div>
