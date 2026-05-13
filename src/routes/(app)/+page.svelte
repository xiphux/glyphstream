<script lang="ts">
	import { onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import { AlertCircle, ArrowUp, Plus, X } from 'lucide-svelte';
	import ModelPicker from '$lib/components/chat/ModelPicker.svelte';
	import { AttachmentStore, attachmentsAllowedFor } from '$lib/attachments.svelte';
	import { composerEnterHandler } from '$lib/composer-keys';
	import type { CreateConversationRequest } from '$lib/types/api';
	import { preferredFirstName, timeOfDayGreeting } from '$lib/greeting';

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

	// Auto-resize composer (same pattern as the chat-page composer).
	let composerEl = $state<HTMLTextAreaElement | null>(null);
	const COMPOSER_MAX_HEIGHT_PX = 240;
	$effect(() => {
		const el = composerEl;
		void text;
		if (!el) return;
		el.style.height = 'auto';
		const next = Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT_PX);
		el.style.height = `${next}px`;
		el.style.overflowY = el.scrollHeight > COMPOSER_MAX_HEIGHT_PX ? 'auto' : 'hidden';
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
				const err = await safeReadError(createRes);
				throw new Error(err);
			}
			const { conversation } = (await createRes.json()) as {
				conversation: { id: string };
			};

			// Hand the first message off to the chat page so the streaming
			// response renders inside the right route lifecycle. Stash in
			// sessionStorage (per-conversation key) and navigate. Payload is
			// JSON-encoded so we can carry attached media ids alongside the
			// text — the chat page forwards them on the send call.
			const key = `glyphstream:pendingFirstMessage:${conversation.id}`;
			window.sessionStorage.setItem(
				key,
				JSON.stringify({ text, attachedMediaIds: attachments.readyMediaIds() })
			);
			attachments.clear();
			await goto(`/chat/${conversation.id}`, { invalidateAll: true });
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}

	async function safeReadError(res: Response): Promise<string> {
		try {
			const j = await res.json();
			return j.message ?? `HTTP ${res.status}`;
		} catch {
			return `HTTP ${res.status}`;
		}
	}

	// Drag-drop + paste, same pattern as the chat-id composer.
	let isDraggingOver = $state(false);
	let dragDepth = 0;

	function dragHasFiles(e: DragEvent): boolean {
		return Array.from(e.dataTransfer?.types ?? []).includes('Files');
	}

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
		const files = Array.from(e.dataTransfer?.files ?? []).filter((f) =>
			f.type.startsWith('image/')
		);
		if (files.length > 0) {
			void attachments.addFiles(files);
		}
	}

	function onPaste(e: ClipboardEvent) {
		if (!allowAttachments) return;
		const items = e.clipboardData?.items;
		if (!items) return;
		const files: File[] = [];
		for (const item of items) {
			if (item.kind === 'file' && item.type.startsWith('image/')) {
				const f = item.getAsFile();
				if (f) files.push(f);
			}
		}
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
			<h1 class="text-center text-3xl font-semibold tracking-tight sm:text-4xl">
				<span class="text-neutral-900 dark:text-neutral-100">{greeting}, {userFirstName}</span>
			</h1>
		</div>

		<form
			onsubmit={startChat}
			ondragenter={onDragEnter}
			ondragover={onDragOver}
			ondragleave={onDragLeave}
			ondrop={onDrop}
			class="relative rounded-2xl border border-neutral-300 bg-white px-3 py-2 shadow-sm transition focus-within:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900 dark:focus-within:border-neutral-500"
		>
			{#if attachments.items.length > 0}
				<div class="flex flex-wrap gap-2 border-b border-neutral-200 px-1 pb-2 dark:border-neutral-800">
					{#each attachments.items as a (a.clientId)}
						<div
							class="group/thumb relative h-16 w-16 shrink-0 overflow-hidden rounded-md border border-neutral-200 bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-800"
							title={a.error ?? a.contentType}
						>
							<img
								src={a.objectUrl}
								alt=""
								class="h-full w-full object-cover {a.status === 'uploading'
									? 'opacity-60'
									: a.status === 'error'
										? 'opacity-40'
										: ''}"
							/>
							{#if a.status === 'uploading'}
								<div
									class="absolute inset-0 flex items-center justify-center bg-black/20 text-white"
								>
									<div class="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent"></div>
								</div>
							{:else if a.status === 'error'}
								<div
									class="absolute inset-0 flex items-center justify-center bg-red-600/40 text-white"
								>
									<AlertCircle size={20} strokeWidth={2} />
								</div>
							{/if}
							<button
								type="button"
								onclick={() => attachments.remove(a.clientId)}
								aria-label="Remove attachment"
								title="Remove"
								class="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-neutral-900/80 text-white opacity-0 transition group-hover/thumb:opacity-100 hover:bg-neutral-900 focus-visible:opacity-100"
							>
								<X size={12} strokeWidth={2.5} />
							</button>
						</div>
					{/each}
				</div>
			{/if}
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
