<script lang="ts">
	import { goto } from '$app/navigation';
	import ModelPicker from '$lib/components/chat/ModelPicker.svelte';
	import type {
		CreateConversationRequest,
		SendMessageRequest,
		SendMessageResponse
	} from '$lib/types/api';

	let { data } = $props();

	let modelId = $state('');
	$effect(() => {
		if (!modelId) {
			modelId = data.models.find((m) => m.kind === 'chat')?.id ?? '';
		}
	});
	let text = $state('');
	let busy = $state(false);
	let errorMsg = $state<string | null>(null);

	async function startChat(e: Event) {
		e.preventDefault();
		if (!modelId || !text.trim() || busy) return;
		busy = true;
		errorMsg = null;
		try {
			// Create the conversation
			const createBody: CreateConversationRequest = { modelId };
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

			// Send the first message — wait for the assistant reply, then navigate.
			// Sending in-flight (rather than after navigation) keeps the page state
			// simple: by the time we land on /chat/[id], history already contains
			// the round-trip.
			const sendBody: SendMessageRequest = { text };
			const sendRes = await fetch(`/api/conversations/${conversation.id}/messages`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(sendBody)
			});
			if (!sendRes.ok) {
				const err = await safeReadError(sendRes);
				throw new Error(`Conversation created but first message failed: ${err}`);
			}
			(await sendRes.json()) as SendMessageResponse;

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
			<ModelPicker models={data.models} bind:value={modelId} filterKinds={['chat']} disabled={busy} />
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
				placeholder="Ask anything…"
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
				{busy ? 'Sending…' : 'Start chat'}
			</button>
		</div>
	</form>
</div>
