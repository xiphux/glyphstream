<script lang="ts">
	import { goto } from '$app/navigation';
	import { ArrowUp } from 'lucide-svelte';
	import ModelPicker from '$lib/components/chat/ModelPicker.svelte';
	import type { CreateConversationRequest } from '$lib/types/api';
	import { firstName, timeOfDayGreeting } from '$lib/greeting';

	let { data } = $props();

	// Greeting is computed client-side so it reflects the user's local
	// wall clock (SSR would use the server's timezone). Recomputed in an
	// $effect on mount; falls back to a neutral greeting before hydration.
	let greeting = $state('Hello');
	$effect(() => {
		greeting = timeOfDayGreeting(new Date());
	});
	const userFirstName = $derived(
		firstName(data.user.displayName, data.user.githubUsername)
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
		if (!modelId || !text.trim() || busy) return;
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
			// sessionStorage (per-conversation key) and navigate.
			const key = `glyphstream:pendingFirstMessage:${conversation.id}`;
			window.sessionStorage.setItem(key, text);
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
			class="rounded-2xl border border-neutral-300 bg-white px-3 py-2 shadow-sm transition focus-within:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900 dark:focus-within:border-neutral-500"
		>
			<textarea
				bind:this={composerEl}
				bind:value={text}
				rows="2"
				disabled={busy}
				placeholder={composerPlaceholder}
				onkeydown={(e) => {
					if (e.key === 'Enter' && !e.shiftKey) {
						e.preventDefault();
						void startChat(e);
					}
				}}
				class="block w-full resize-none border-0 bg-transparent px-2 py-2 text-sm focus:outline-none disabled:opacity-50"
			></textarea>

			<div class="flex items-center justify-end gap-2 px-1 pt-1">
				<!--
					Inline model selector: rendered as a borderless dropdown so
					it reads as a soft control inside the box rather than a
					separate field. Native <select> keeps keyboard nav + mobile
					native picker for free. justify-end groups it next to the
					send button rather than scattering them across the row;
					the empty space on the left is reserved for future
					attachment controls.
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
					disabled={!modelId || !text.trim() || busy}
					aria-label="Send message"
					title="Send"
					class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-white transition hover:bg-neutral-800 disabled:opacity-30 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
				>
					<ArrowUp size={16} strokeWidth={2.5} />
				</button>
			</div>
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
