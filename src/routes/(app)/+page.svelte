<script lang="ts">
	import { onDestroy, tick, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { AlertCircle, ArrowUp, Plus, X } from 'lucide-svelte';
	import ModelPicker from '$lib/components/chat/ModelPicker.svelte';
	import AttachmentThumbnails from '$lib/components/AttachmentThumbnails.svelte';
	import { AttachmentStore, attachmentsAllowedFor } from '$lib/attachments.svelte';
	import { composerEnterHandler } from '$lib/composer-keys';
	import { autoResizeTextarea, dragHasFiles, extractImageFiles } from '$lib/composer';
	import {
		GALLERY_LAUNCH_KEY,
		type GalleryLaunchIntent
	} from '$lib/gallery-launch';
	import type { CreateConversationRequest } from '$lib/types/api';
	import { preferredFirstName, timeOfDayGreeting } from '$lib/greeting';
	import { errorMessageFromResponse } from '$lib/fetch-error';
	import { pendingFirstMessageKey, type PendingFirstMessage } from '$lib/pending-first-message';

	let { data } = $props();

	// Greeting is computed client-side so it reflects the user's local
	// wall clock (SSR would use the server's timezone). Recomputed in an
	// $effect on mount; falls back to a neutral greeting before hydration.
	let greeting = $state('Hello');
	$effect(() => {
		greeting = timeOfDayGreeting(new Date());
	});
	const userFirstName = $derived(
		preferredFirstName(
			data.prefs?.name,
			data.user.displayName,
			data.user.githubUsername
		)
	);

	// Selection value mirrors what ModelPicker emits:
	//   - "endpointId::upstreamId"  → base model
	//   - "custom::{customModelId}" → saved preset
	let modelId = $state('');
	$effect(() => {
		if (!modelId) {
			modelId =
				data.models.find((m) => m.kind === 'chat')?.id ??
				data.models.find((m) => m.kind === 'image')?.id ??
				data.models.find((m) => m.kind === 'video')?.id ??
				'';
		}
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
	const pickedKind = $derived(resolvedBase?.kind ?? 'chat');
	const composerPlaceholder = $derived(
		pickedKind === 'image'
			? 'Describe an image to generate…'
			: pickedKind === 'video'
				? 'Describe a video to generate…'
				: 'How can I help you today?'
	);

	let text = $state('');
	let busy = $state(false);
	let errorMsg = $state<string | null>(null);

	// Attachments are picked here and travel into the chat-id page via
	// sessionStorage along with the first-message text — the chat-id page
	// then forwards them to the message-send call.
	const attachments = new AttachmentStore();
	let fileInputEl = $state<HTMLInputElement | null>(null);
	const allowAttachments = $derived(attachmentsAllowedFor(pickedKind));
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
				text = intent.prompt;
				// The auto-resize effect *will* re-fire on the `text`
				// change, but in the same on-mount effect batch as
				// this pickup — at which point Svelte hasn't yet
				// flushed `bind:value` to the DOM, so scrollHeight
				// reads the still-empty textarea. `tick()` resolves
				// after the pending DOM commit, so a manual resize
				// call there sees the actual content height.
				void tick().then(() => autoResizeComposer());
			} else if (intent.kind === 'starting-image') {
				attachments.attachExisting(intent.mediaId);
			}
		});
	});

	// Auto-resize composer (same pattern as the chat-page composer).
	// Factored into a function so external triggers can request a
	// resize after manipulating `text` outside of normal user typing —
	// e.g. the gallery-launch pickup effect, which sets `text` and
	// then has to call this explicitly via `tick()` because Svelte
	// batches the in-effect state change with the DOM flush of the
	// `bind:value` update, so scrollHeight here would otherwise still
	// reflect the empty pre-paste state.
	let composerEl = $state<HTMLTextAreaElement | null>(null);
	function autoResizeComposer() {
		if (composerEl) autoResizeTextarea(composerEl);
	}
	$effect(() => {
		void text;
		autoResizeComposer();
	});

	// Autofocus the composer on load — typing a prompt to start a new
	// conversation is the entire purpose of this page, so the cursor
	// belongs in the box without a click or tab. Runs once on mount
	// (composerEl flips null→element a single time).
	//
	// Skipped on touch devices, where an unprompted focus springs the
	// on-screen keyboard open over the greeting.
	$effect(() => {
		if (window.matchMedia?.('(pointer: coarse)').matches) return;
		composerEl?.focus();
	});

	async function startChat(e: Event) {
		e.preventDefault();
		if (!modelId || busy) return;
		if (!text.trim() && attachments.items.length === 0) return;
		if (attachments.isBusy) return;
		busy = true;
		errorMsg = null;
		try {
			// Build the create request based on what the picker selected. For
			// presets we send `customModelId` and let the server resolve the
			// base model + system prompt + parameters from the stored row.
			const createBody: CreateConversationRequest = modelId.startsWith('custom::')
				? {
						customModelId: modelId.slice('custom::'.length),
						modelKind: resolvedBase?.kind
					}
				: {
						modelId,
						modelKind: resolvedBase?.kind
					};
			const createRes = await fetch('/api/conversations', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(createBody)
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
			// JSON-encoded so we can carry attached media ids alongside the
			// text — the chat page forwards them on the send call.
			window.sessionStorage.setItem(
				pendingFirstMessageKey(conversation.id),
				JSON.stringify({
					text,
					attachedMediaIds: attachments.readyMediaIds()
				} satisfies PendingFirstMessage)
			);
			attachments.clear();
			await goto(`/chat/${conversation.id}`, { invalidateAll: true });
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}

	// Drag-drop + paste, same pattern as the chat-id composer.
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
		if (files.length > 0) {
			void attachments.addFiles(files);
		}
	}

	function onPaste(e: ClipboardEvent) {
		if (!allowAttachments) return;
		const files = extractImageFiles(e.clipboardData);
		if (files.length > 0) {
			e.preventDefault();
			void attachments.addFiles(files);
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
			<div class="flex h-16 w-16 items-center justify-center rounded-full bg-neutral-100 ring-1 ring-neutral-200 dark:bg-neutral-800/70 dark:ring-neutral-700/70">
				<svg
					viewBox="0 0 32 32"
					class="h-8 w-8 text-neutral-700 dark:text-neutral-200"
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
					<span class="text-neutral-900 dark:text-neutral-100">{greeting}, {userFirstName}</span>
				</h1>
			{/if}
		</div>

		<form
			onsubmit={startChat}
			ondragenter={onDragEnter}
			ondragover={onDragOver}
			ondragleave={onDragLeave}
			ondrop={onDrop}
			class="relative rounded-2xl border border-neutral-300 bg-white px-3 py-2 shadow-sm transition focus-within:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900 dark:focus-within:border-neutral-500"
		>
			<AttachmentThumbnails {attachments} class="px-1" />
			<textarea
				bind:this={composerEl}
				bind:value={text}
				rows="2"
				disabled={busy}
				placeholder={composerPlaceholder}
				onkeydown={composerEnterHandler(
					data.prefs?.enterBehavior ?? 'send',
					(e) => void startChat(e)
				)}
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
							if (t.files && t.files.length > 0) {
								void attachments.addFiles(t.files);
							}
							t.value = '';
						}}
					/>
					<button
						type="button"
						onclick={() => fileInputEl?.click()}
						disabled={busy}
						aria-label="Attach image"
						title="Attach image"
						class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-700 disabled:opacity-30 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
					>
						<Plus size={18} strokeWidth={2.25} />
					</button>
				{/if}
				<div class="flex-1"></div>
				<!--
					Inline model selector: rendered as a borderless dropdown so
					it reads as a soft control inside the box. Native keyboard nav
					+ mobile picker for free.
				-->
				<ModelPicker
					models={data.models}
					customModels={data.customModels}
					bind:value={modelId}
					filterKinds={['chat', 'image', 'video']}
					disabled={busy}
					inline
				/>
				<button
					type="submit"
					disabled={!modelId ||
						(!text.trim() && attachments.items.length === 0) ||
						busy ||
						attachments.isBusy}
					aria-label="Send message"
					title="Send"
					class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-white transition hover:bg-neutral-800 disabled:opacity-30 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
				>
					<ArrowUp size={16} strokeWidth={2.5} />
				</button>
			</div>
			{#if isDraggingOver}
				<div
					aria-hidden="true"
					class="pointer-events-none absolute inset-0 flex items-center justify-center rounded-2xl border-2 border-dashed border-neutral-500 bg-neutral-100/85 text-sm text-neutral-700 backdrop-blur-sm dark:border-neutral-400 dark:bg-neutral-900/85 dark:text-neutral-200"
				>
					Drop image to attach
				</div>
			{/if}
		</form>

		{#if data.models.length === 0}
			<p class="mt-3 text-center text-xs text-amber-700 dark:text-amber-300">
				No models available — check <code>config.toml</code> and your endpoints.
			</p>
		{/if}

		{#if errorMsg}
			<div
				class="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200"
			>
				{errorMsg}
			</div>
		{/if}
	</div>
</div>
