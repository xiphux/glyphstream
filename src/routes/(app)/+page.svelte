<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { browser } from '$app/environment';
	import { afterNavigate, goto, replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import { ArrowUp, VenetianMask } from '@lucide/svelte';
	import ModelPicker from '$lib/components/chat/ModelPicker.svelte';
	import FeatureTogglesMenu from '$lib/components/FeatureTogglesMenu.svelte';
	import ComposerCore from '$lib/components/chat/ComposerCore.svelte';
	import SplitAttachmentsToggle from '$lib/components/chat/SplitAttachmentsToggle.svelte';
	import { AttachmentStore, attachmentsAllowedFor } from '$lib/attachments.svelte';
	import { GALLERY_LAUNCH_KEY, type GalleryLaunchIntent } from '$lib/gallery-launch';
	import { PROMPT_REUSE_KEY, type PromptReuseIntent } from '$lib/prompt-reuse';
	import {
		expandCompareSelections,
		resolveActiveModelKind,
		type CompareSelection,
		type FanoutModel,
	} from '$lib/fanout';
	import type { CreateConversationRequest, FeatureCategory } from '$lib/types/api';
	import {
		composeGreeting,
		greetingContextKey,
		pickGreeting,
		preferredFirstName,
	} from '$lib/greeting';
	import { errorMessageFromResponse } from '$lib/fetch-error';
	import { noticeMessage } from '$lib/notices';
	import { toast } from '$lib/toast.svelte';
	import { toggleFavoriteModel } from '$lib/favorite-models';
	import { saveModelSet, deleteModelSet } from '$lib/model-sets';
	import { stripSkillCommand } from '$lib/skill-command';
	import { pendingFirstMessageKey, type PendingFirstMessage } from '$lib/pending-first-message';
	import { loadDraft, clearDraft, createDraftWriter } from '$lib/composer-draft';
	import { privateView } from '$lib/private-chat.svelte';

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

	// "Private chat" toggle — transient per page load, like disabledFeatures: a
	// fresh new-chat box always starts non-private. Chosen only here (immutable
	// once the conversation exists), carried into the create request, and
	// published to `privateView` so the (app) layout paints the incognito re-tint
	// live as you toggle it.
	let isPrivate = $state(false);
	$effect(() => {
		privateView.active = isPrivate;
		// The new-chat screen owns an interactive toggle — publish it so the mobile
		// top bar can host the control (on mobile the corner toggle is hidden).
		privateView.toggleable = true;
		privateView.onToggle = () => (isPrivate = !isPrivate);
		return () => privateView.reset();
	});

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

	// A launch intent's own feature toggles, awaiting the seeding effect below.
	// Armed ONLY when the intent also changes `modelId` (which is what re-fires
	// that effect); consumed on the very next run so a later user-driven model
	// switch gets the normal preset-defaults behavior. Plain `let`, not `$state`
	// — it's a one-shot baton between two effects, not rendered anywhere.
	let pendingDisabledFeatures: FeatureCategory[] | null = null;

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
			// A reused prompt carries the source conversation's toggles, which
			// already reflect whatever the user settled on there. Those beat both
			// the preset defaults and the base-model reset — otherwise this effect,
			// re-fired by the intent's own modelId write, would immediately undo it.
			if (pendingDisabledFeatures) {
				disabledFeatures = pendingDisabledFeatures;
				pendingDisabledFeatures = null;
				return;
			}
			if (id.startsWith('custom::')) {
				const cm = data.customModels.find((m) => m.id === id.slice('custom::'.length));
				disabledFeatures = cm ? [...cm.defaultDisabledFeatures] : [];
			} else {
				disabledFeatures = [];
			}
		});
	});
	const pickedKind = $derived(resolvedBase?.kind ?? 'chat');
	// The ONE kind every kind-dependent control reads, so the single-model picker
	// and the compare cart can't drift the UI apart (placeholder, skills,
	// attachments, split, feature toggles). Reflects the compare cart's kind when
	// a set is active, else the single picked kind. See resolveActiveModelKind.
	const activeKind = $derived(
		resolveActiveModelKind(
			compareMode,
			fanoutFirstModels.map((m) => m.modelKind),
			pickedKind,
		),
	);
	// `/skill-name` autocomplete is offered only when starting a CHAT with the
	// `skills` category enabled; the chat page's first send forwards the
	// activation. Undefined → ComposerCore shows no menu.
	const skillCommands = $derived(
		activeKind === 'chat' && !disabledFeatures.includes('skills') ? data.enabledSkills : undefined,
	);
	const composerPlaceholder = $derived(
		activeKind === 'image'
			? 'Describe an image to generate…'
			: activeKind === 'video'
				? 'Describe a video to generate…'
				: 'How can I help you today?',
	);

	// Restore a half-typed prompt left over from a previous visit (e.g. an iOS
	// PWA that was frozen in the background and reloaded). The new-chat box uses
	// the `null` draft slot. SSR returns '' so there's no hydration mismatch.
	let text = $state(browser ? loadDraft(null) : '');
	let busy = $state(false);
	let errorMsg = $state<string | null>(null);

	// Attachments are picked here and travel into the chat-id page via
	// sessionStorage along with the first-message text — the chat-id page
	// then forwards them to the message-send call.
	const attachments = new AttachmentStore();
	let coreRef = $state<{ focus: () => void } | null>(null);
	const allowAttachments = $derived(attachmentsAllowedFor(activeKind));
	// Split-attachments availability + cross-product count (mirrors ChatComposer).
	const canSplit = $derived(
		(activeKind === 'image' || activeKind === 'video') && attachments.readyImageCount >= 2,
	);
	const splitModelCount = $derived(
		compareMode && fanoutFirstModels.length >= 2 ? fanoutFirstModels.length : 1,
	);
	$effect(() => {
		if (!canSplit && splitAttachments) splitAttachments = false;
	});
	onDestroy(() => attachments.destroy());

	// Autosave the in-progress prompt so it survives a reload. Debounced, with a
	// force-flush on page-hide (see createDraftWriter) for the iOS-PWA-killed
	// case. Cleared explicitly once the chat actually starts.
	const draftWriter = createDraftWriter();
	$effect(() => {
		draftWriter.save(null, text);
	});
	onDestroy(() => draftWriter.dispose());

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

	// Pick up a "New chat from this prompt" intent stashed by the chat page.
	// Same consume-and-clear + untrack discipline as the gallery-launch effect
	// above; runs after it, and the two are mutually exclusive in practice
	// (different entry points). Never submits — the prompt lands in the box for
	// the user to tweak.
	$effect(() => {
		if (typeof window === 'undefined') return;
		const raw = window.sessionStorage.getItem(PROMPT_REUSE_KEY);
		if (!raw) return;
		window.sessionStorage.removeItem(PROMPT_REUSE_KEY);

		let intent: PromptReuseIntent;
		try {
			intent = JSON.parse(raw) as PromptReuseIntent;
		} catch {
			return;
		}

		untrack(() => {
			// The intent's model was resolved against the live model list when it was
			// created, but config can change between pages — re-check, and fall
			// through to the default-modelId effect's choice if it's gone.
			const known = intent.modelId?.startsWith('custom::')
				? data.customModels.some((m) => m.id === intent.modelId!.slice('custom::'.length))
				: data.models.some((m) => m.id === intent.modelId);
			if (intent.modelId && known) {
				// Arm the baton only when this write will actually re-fire the
				// seeding effect; otherwise it would sit armed and swallow the next
				// user-driven model switch's preset defaults.
				if (intent.modelId !== modelId) {
					pendingDisabledFeatures = [...intent.disabledFeatures];
				}
				modelId = intent.modelId;
			}
			disabledFeatures = [...intent.disabledFeatures];

			if (intent.compareSelections?.length) {
				compareSelections = intent.compareSelections.map((s) => ({ ...s }));
				compareMode = true;
			}
			for (const mediaId of intent.mediaIds) {
				attachments.attachExisting(mediaId);
			}
			isPrivate = intent.private;

			// The box may already hold an unsent draft. The prompt the user just
			// asked for wins, but losing typed text silently would be worse than
			// the collision — so offer it back.
			const previous = text;
			text = intent.text;
			if (previous.trim() && previous !== intent.text) {
				toast.info('Prompt loaded — your draft was replaced', {
					action: {
						label: 'Undo',
						handler: () => {
							text = previous;
						},
					},
				});
			}
		});
	});

	// Prefill the composer from a `#q=` URL fragment so an external entry
	// point (e.g. an iOS share-sheet Shortcut, which iOS won't let target a
	// PWA via the Web Share Target API) can hand us a prompt to start from.
	// A hash fragment — not a `?q=` query string — is deliberate: the fragment
	// never reaches the server, so it sidesteps the reverse-proxy / Node
	// request-line size limits a long image prompt would otherwise blow past,
	// and it keeps the prompt out of server logs. Runs from afterNavigate (so
	// it also catches client-side navs back to this page) and only fills an
	// empty box, so it never clobbers a gallery-launch regenerate prompt.
	afterNavigate(() => {
		const hash = window.location.hash;
		if (!hash) return;
		const q = new URLSearchParams(hash.slice(1)).get('q');
		if (!q) return;
		if (!text) text = q;
		// Drop the fragment so a manual refresh won't re-prefill an
		// already-sent message. Deferred a microtask because on the initial
		// load afterNavigate fires just *before* SvelteKit flags the router
		// "started", and replaceState throws until then; by the next microtask
		// it's safe. Best-effort — a lingering fragment is harmless.
		queueMicrotask(() => {
			try {
				replaceState(window.location.pathname + window.location.search, page.state);
			} catch {
				/* router not ready / state unserializable — leave the fragment */
			}
		});
	});

	// Surface a `?notice=` handed to us by a load function that redirected
	// here instead of erroring — today, a chat route whose conversation is
	// gone. Strip the param afterwards so a refresh doesn't replay the toast;
	// same deferred replaceState dance as the fragment above, and other params
	// (`?model=`) are preserved.
	afterNavigate(() => {
		const message = noticeMessage(page.url.searchParams.get('notice'));
		if (!message) return;
		toast.error(message);
		const params = new URLSearchParams(page.url.searchParams);
		params.delete('notice');
		const query = params.size > 0 ? `?${params}` : '';
		queueMicrotask(() => {
			try {
				replaceState(page.url.pathname + query + window.location.hash, page.state);
			} catch {
				/* router not ready / state unserializable — leave the param */
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
		// Consume a leading `/skill-name` (explicit activation) when starting a
		// chat with skills enabled; forwarded on the first send via the pending-
		// message handoff. Gated so a disabled-skills / non-chat start sends `/foo`
		// literally.
		const skillsActive = activeKind === 'chat' && !disabledFeatures.includes('skills');
		const { text: cleanText, activatedSkillNames } = skillsActive
			? stripSkillCommand(text.trim(), data.enabledSkills)
			: { text: text.trim(), activatedSkillNames: [] as string[] };
		if ((!fanout && !effectiveModelId) || busy) return;
		if (!cleanText && attachments.items.length === 0) return;
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
				createBody = { modelId: singleCompareModel, modelKind: fanoutFirstModels[0].modelKind };
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
			if (isPrivate) {
				createBody.private = true;
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
					text: cleanText,
					attachedMediaIds: attachments.readyMediaIds(),
					...(fanout ? { fanoutModels: fanout } : {}),
					...(splitImageIds ? { splitImageIds } : {}),
					...(activatedSkillNames.length ? { activatedSkillNames } : {}),
				} satisfies PendingFirstMessage),
			);
			attachments.clear();
			// The prompt is now handed off — drop its saved draft so it can't be
			// restored into a fresh new-chat box. cancel() drops the pending write;
			// clearDraft() removes the stored key now (load-bearing: the writer
			// would otherwise only clear it on the next debounced commit).
			draftWriter.cancel();
			clearDraft(null);
			await goto(`/chat/${conversation.id}`, { invalidateAll: true });
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}
</script>

<div class="zero-state relative flex h-full flex-col items-center overflow-hidden">
	<!--
		Accent aura: a soft radial bloom anchored behind the greeting +
		composer. Drawn from --color-accent via color-mix, so it tints to
		each theme (sky / clay / green) and adapts to dark mode for free
		(strength bumped under [data-scheme='dark'] where the accent reads
		brighter). Pure CSS, no assets — sits behind the stack (z-0) and
		is inert to pointer/AT. Frames the composer rather than competing.
	-->
	<div class="aura" aria-hidden="true"></div>

	<!--
		Private-chat toggle — upper-right, the incognito-toggle spot users know
		from Claude / ChatGPT / Gemini. A pill that fills in when armed; the whole
		screen re-tints (via privateView → [data-private]) so the state is
		unmistakable, not just this control. Only offered on the new-chat screen:
		private is fixed at creation, so there's nothing to toggle on an open chat.
		Desktop only (hidden sm:flex) — on mobile the same toggle lives in the top
		bar (see the layout) so it shares the hamburger row instead of sitting
		crooked on its own line. Published to privateView so that row can drive it.
	-->
	<button
		type="button"
		onclick={() => (isPrivate = !isPrivate)}
		aria-pressed={isPrivate}
		title={isPrivate
			? 'Private chat is on — nothing from this chat is saved to memories, summaries, or search'
			: 'Start a private chat — sealed from memories, personalization, search, and web/MCP tools'}
		class="absolute right-3 top-3 z-20 hidden items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition sm:flex {isPrivate
			? 'border-transparent bg-accent text-accent-fg shadow-sm'
			: 'border-border bg-surface-panel/70 text-fg-muted hover:bg-surface-raised hover:text-fg'}"
	>
		<VenetianMask size={15} strokeWidth={2.25} />
		<span>{isPrivate ? 'Private' : 'Private chat'}</span>
	</button>

	<!--
		Zero-state reflows by form factor with flexible spacers (no JS
		breakpoint): on desktop (sm+) the top + bottom spacers both grow
		and center the greeting + composer together as one group; on mobile
		the middle spacer grows instead, dropping the composer to the bottom
		for thumb reach while the greeting stays centered in the space above
		— the Gemini / Claude / ChatGPT mobile pattern.
	-->
	<div class="flex-1"></div>

	<!--
		Greeting block: glyph mark inside a soft circular badge, then
		"Good evening, Chris" line. The badge wrapper grounds the mark
		against the page bg the same way the composer below does, with
		a subtle ring + slightly raised bg shade. Mark is inlined (not
		<img>) so its strokes use currentColor and adapt to dark mode.

		In private mode we deliberately drop the personalized greeting: a
		mode whose whole point is airgapping your personal info shouldn't
		open with "Hi, {name}". The badge swaps to the mask glyph and the
		heading becomes a brief explainer of what private mode seals — both
		to state the rules and to reassure that nothing personal is in play.
	-->
	<div class="relative z-10 mb-6 flex w-full max-w-2xl flex-col items-center gap-4">
		<!-- Badge: glyph mark ↔ private mask, stacked in one grid cell and
		     cross-faded on opacity so the mode switch doesn't hard-swap. -->
		<div
			class="grid h-16 w-16 place-items-center rounded-full bg-surface-raised ring-1 ring-border"
		>
			<span
				class="col-start-1 row-start-1 transition-opacity duration-300 {isPrivate
					? 'opacity-0'
					: 'opacity-100'}"
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
			</span>
			<span
				class="col-start-1 row-start-1 transition-opacity duration-300 {isPrivate
					? 'opacity-100'
					: 'opacity-0'}"
			>
				<VenetianMask class="h-8 w-8 text-accent" strokeWidth={2} aria-hidden="true" />
			</span>
		</div>
		<!-- The private explainer's content, shared by the cross-fade layer (when a
		     greeting is present) and the standalone case (greeting off). -->
		{#snippet privateExplainer()}
			<h1 class="text-center text-3xl font-semibold tracking-tight sm:text-4xl">
				<span class="text-fg">Private chat</span>
			</h1>
			<p class="max-w-sm text-center text-sm text-fg-muted">
				Off the record — kept out of your memories, personalization, and search.
			</p>
		{/snippet}
		{#if data.prefs?.showGreeting ?? true}
			<!-- Greeting ↔ private explainer stacked in one grid cell so the composer
			     below never snaps as the blocks swap — they cross-fade, and the cell
			     reserves the taller (private) block's height in both states. -->
			<div class="grid w-full place-items-center">
				<!-- aria-hidden on the wrapper (not the h1) so the inactive layer leaves
				     the a11y tree without tripping the "hidden heading" lint. -->
				<div
					aria-hidden={isPrivate}
					class="col-start-1 row-start-1 transition-opacity duration-300 {isPrivate
						? 'opacity-0'
						: 'opacity-100'}"
				>
					<h1 class="text-center text-3xl font-semibold tracking-tight sm:text-4xl">
						<span class="text-fg">{composedGreeting}</span>
					</h1>
				</div>
				<div
					aria-hidden={!isPrivate}
					class="col-start-1 row-start-1 flex flex-col items-center gap-1.5 transition-opacity duration-300 {isPrivate
						? 'opacity-100'
						: 'opacity-0'}"
				>
					{@render privateExplainer()}
				</div>
			</div>
		{:else if isPrivate}
			<!-- Greeting off: no sibling to cross-fade or reserve height against, so
			     render the explainer alone (it just snaps in on the explicit toggle)
			     rather than leaving an always-present, invisible layer of dead space. -->
			<div class="flex flex-col items-center gap-1.5">
				{@render privateExplainer()}
			</div>
		{/if}
	</div>

	<!--
			Middle spacer: grows on mobile to drop the composer to the bottom
			edge; collapses on desktop so it sits right under the greeting.
		-->
	<div class="flex-1 sm:hidden"></div>

	<!-- Composer, plus any inline notices below it. -->
	<div class="relative z-10 w-full max-w-2xl">
		<ComposerCore
			bind:this={coreRef}
			bind:text
			{attachments}
			{allowAttachments}
			disabled={busy}
			placeholder={composerPlaceholder}
			rows={2}
			enterBehavior={data.prefs?.enterBehavior ?? 'send'}
			{skillCommands}
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
					modelKind={activeKind}
					disabled={busy}
					private={isPrivate}
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
					modelSets={data.prefs?.modelSets ?? []}
					onSaveModelSet={(name, sels) =>
						void saveModelSet(data.prefs?.modelSets ?? [], name, sels)}
					onDeleteModelSet={(id) => void deleteModelSet(data.prefs?.modelSets ?? [], id)}
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

	<!--
		Bottom spacer: desktop only, balances the top spacer so the
		greeting + composer group stays vertically centered.
	-->
	<div class="hidden flex-1 sm:block"></div>
</div>

<style>
	/* Zero-state page padding. Kept in the scoped block (not Tailwind
	   utilities) so the mobile bottom padding can fold in the iOS
	   home-indicator safe area via env() — the composer sits near the
	   bottom edge on small screens, so it must clear the inset. */
	.zero-state {
		padding: 2rem 1rem calc(1.5rem + env(safe-area-inset-bottom));
	}
	@media (min-width: 640px) {
		.zero-state {
			padding: 2rem 1rem;
		}
	}

	.aura {
		position: absolute;
		inset: 0;
		z-index: 0;
		pointer-events: none;
		/* Soft, diffuse ellipse that tracks the composer — the element the
		   bloom is meant to highlight. Mobile-first: low + wide, sitting
		   behind the bottom-anchored composer and fading up toward the
		   greeting; the sm+ override below recenters it once the composer
		   moves back to the middle. Fades cleanly to the page bg. */
		background: radial-gradient(
			var(--aura-size, 118% 60%) at 50% var(--aura-y, 82%),
			color-mix(in oklch, var(--color-accent) var(--aura-strength, 13%), transparent),
			transparent 70%
		);
		/* Resting state (post-entrance). Explicit so the private toggle's
		   transition has a real from-value to animate; the entrance animation uses
		   fill-mode `backwards` (not `both`), so once it ends it stops pinning these
		   and the transition below governs. */
		opacity: 1;
		transform: none;
		/* Reverse the bloom when private mode arms (and re-bloom when it disarms):
		   fade + shrink back toward the composer (desktop) / fade (mobile). Mirrors
		   the entrance, run as a transition rather than an animation so it plays on
		   the state toggle, not on mount. */
		transition:
			opacity 0.5s var(--ease-standard, cubic-bezier(0.3, 0, 0, 1)),
			transform 0.5s var(--ease-standard, cubic-bezier(0.3, 0, 0, 1));
	}

	/* Private mode: the accent-tinted bloom would fight the incognito re-tint, so
	   retract it. Just opacity on mobile (bottom-anchored bloom — a transform would
	   reintroduce the iOS clip-rasterize artifact the entrance avoids); the sm+
	   rule below adds the shrink-back. Global because [data-private] lives on
	   <html>. */
	:global([data-private]) .aura {
		opacity: 0;
	}
	@media (min-width: 640px) {
		:global([data-private]) .aura {
			/* Shrinks toward the composer (transform-origin is set on the sm+ aura),
			   the entrance bloom played in reverse. */
			transform: scale(0.2);
		}
	}

	@media (min-width: 640px) {
		.aura {
			--aura-size: 72% 58%;
			--aura-y: 45%;
		}
	}

	/* Accent runs brighter in dark, and a faint tint on a near-white surface
	   needs less punch than a glow on a dark one — so lift the mix in dark. */
	:global([data-scheme='dark']) .aura {
		--aura-strength: 22%;
	}

	/* Bloom in on load. Base (mobile) is opacity-only: the mobile bloom is
	   bottom-anchored, so its gradient is still colored where it meets the
	   bottom edge and gets clipped there. iOS Safari (esp. standalone PWA)
	   rasterizes the animating layer to a texture clipped to the viewport,
	   then scales it — so that hard bottom edge reads as a square growing to
	   the edges. Fading opacity without a transform sidesteps it entirely. */
	@media (prefers-reduced-motion: no-preference) {
		.aura {
			/* `backwards` (not `both`): hold the from-state during any delay so there's
			   no first-paint flash, but DON'T pin the to-state after it ends — else the
			   animation's opacity:1 would beat the private-toggle transition in the
			   cascade and the bloom would snap out instead of fading. */
			animation: aura-fade 0.9s var(--ease-emphasized, cubic-bezier(0.3, 0, 0, 1)) backwards;
		}
	}

	/* Desktop: the bloom is centered and fully fades to transparent inside
	   its box on all edges, so there's no clipped edge to rasterize — the
	   scale bloom (grow from a small point at the composer) renders cleanly.
	   transform-origin tracks --aura-y so it expands from the composer. */
	@media (prefers-reduced-motion: no-preference) and (min-width: 640px) {
		.aura {
			transform-origin: 50% var(--aura-y, 45%);
			animation-name: aura-bloom;
		}
	}

	@keyframes aura-fade {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}

	@keyframes aura-bloom {
		from {
			opacity: 0;
			transform: scale(0.2);
		}
		to {
			opacity: 1;
			transform: scale(1);
		}
	}
</style>
