<script lang="ts">
	import { goto } from '$app/navigation';
	import ModelPicker from '$lib/components/chat/ModelPicker.svelte';
	import type { CreateConversationRequest } from '$lib/types/api';

	let { data } = $props();

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
				: 'Ask anything…'
	);
	const submitLabel = $derived(
		pickedKind === 'image'
			? 'Generate image'
			: pickedKind === 'video'
				? 'Generate video'
				: 'Start chat'
	);
	let text = $state('');
	let busy = $state(false);
	let errorMsg = $state<string | null>(null);

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

<div class="flex h-full items-center justify-center px-6 py-12">
	<form
		onsubmit={startChat}
		class="w-full max-w-xl space-y-4 rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
	>
		<div>
			<h1 class="text-xl font-semibold tracking-tight">Start a new chat</h1>
			<p class="mt-1 text-sm text-neutral-500">
				Pick a model and type the first message. Your conversation history will appear in the sidebar.
			</p>
		</div>

		<div>
			<label class="mb-1 block text-xs font-medium text-neutral-700 dark:text-neutral-300" for="model">
				Model
			</label>
			<ModelPicker
				models={data.models}
				customModels={data.customModels}
				bind:value={modelId}
				filterKinds={['chat', 'image', 'video']}
				disabled={busy}
			/>
			{#if data.models.length === 0}
				<p class="mt-1 text-xs text-amber-700 dark:text-amber-300">
					No models available — check <code>config.toml</code> and your endpoints.
				</p>
			{/if}
		</div>

		<div>
			<label class="mb-1 block text-xs font-medium text-neutral-700 dark:text-neutral-300" for="text">
				First message
			</label>
			<textarea
				id="text"
				bind:value={text}
				rows="4"
				disabled={busy}
				placeholder={composerPlaceholder}
				class="w-full resize-none rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm shadow-sm focus:border-neutral-400 focus:outline-none disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900"
			></textarea>
		</div>

		{#if errorMsg}
			<div
				class="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200"
			>
				{errorMsg}
			</div>
		{/if}

		<div class="flex justify-end">
			<button
				type="submit"
				disabled={!modelId || !text.trim() || busy}
				class="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
			>
				{busy ? 'Sending…' : submitLabel}
			</button>
		</div>
	</form>
</div>
