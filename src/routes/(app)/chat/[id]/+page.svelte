<script lang="ts">
	import { tick } from 'svelte';
	import { invalidate } from '$app/navigation';
	import type { ChatMessage, MessagePart, SendMessageResponse } from '$lib/types/api';

	let { data } = $props();

	// Init empty + assign via $effect so navigation invalidation resyncs
	// these without the "captures only initial value" warning. Reads of
	// data.* live entirely inside $effect.
	let messages = $state<ChatMessage[]>([]);
	let title = $state<string | null>(null);
	let modelId = $state('');

	$effect(() => {
		messages = data.conversation.messages;
		title = data.conversation.title;
		modelId = data.conversation.modelId;
	});

	let composerText = $state('');
	let busy = $state(false);
	let errorMsg = $state<string | null>(null);
	let scrollContainer = $state<HTMLElement | null>(null);

	async function send(e: Event) {
		e.preventDefault();
		const text = composerText.trim();
		if (!text || busy) return;
		busy = true;
		errorMsg = null;

		try {
			const res = await fetch(`/api/conversations/${data.conversation.id}/messages`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ text })
			});
			if (!res.ok) {
				const j = await res.json().catch(() => ({}));
				throw new Error(j.message ?? `HTTP ${res.status}`);
			}
			const body = (await res.json()) as SendMessageResponse;
			messages = [...messages, body.userMessage, body.assistantMessage];
			composerText = '';
			await tick();
			scrollToBottom();
			// Keep the sidebar's conversation list (title + ordering) fresh.
			void invalidate('app:conversations');
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}

	function scrollToBottom() {
		if (scrollContainer) {
			scrollContainer.scrollTop = scrollContainer.scrollHeight;
		}
	}

	$effect(() => {
		// Initial scroll to bottom on load and whenever new messages append.
		// Reading messages.length keeps this reactive.
		void messages.length;
		void tick().then(scrollToBottom);
	});

	function partsToText(parts: MessagePart[]): string {
		return parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
	}
</script>

<div class="flex h-full flex-col">
	<header class="flex items-center justify-between border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
		<div class="min-w-0 flex-1">
			<h1 class="truncate text-sm font-semibold">{title ?? 'Untitled chat'}</h1>
			<p class="truncate text-xs text-neutral-500">{modelId}</p>
		</div>
	</header>

	<div bind:this={scrollContainer} class="flex-1 overflow-y-auto px-4 py-4">
		<div class="mx-auto max-w-3xl space-y-4">
			{#each messages as m (m.id)}
				<article
					class="rounded-2xl px-4 py-3 text-sm {m.role === 'user'
						? 'ml-auto max-w-[85%] bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
						: m.role === 'assistant'
							? 'bg-neutral-100 dark:bg-neutral-800'
							: 'bg-amber-50 dark:bg-amber-950/40'}"
				>
					<div class="text-[11px] uppercase tracking-wide opacity-60">{m.role}</div>
					<div class="mt-1 whitespace-pre-wrap break-words">
						{partsToText(m.parts)}
					</div>
				</article>
			{/each}

			{#if busy}
				<article class="rounded-2xl bg-neutral-100 px-4 py-3 text-sm dark:bg-neutral-800">
					<div class="text-[11px] uppercase tracking-wide opacity-60">assistant</div>
					<div class="mt-1 inline-flex gap-1">
						<span class="animate-pulse">·</span>
						<span class="animate-pulse [animation-delay:120ms]">·</span>
						<span class="animate-pulse [animation-delay:240ms]">·</span>
					</div>
				</article>
			{/if}
		</div>
	</div>

	<footer class="border-t border-neutral-200 bg-white px-4 py-3 dark:border-neutral-800 dark:bg-neutral-900">
		<form onsubmit={send} class="mx-auto max-w-3xl">
			{#if errorMsg}
				<div
					class="mb-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200"
				>
					{errorMsg}
				</div>
			{/if}
			<div class="flex items-end gap-2">
				<textarea
					bind:value={composerText}
					rows="2"
					placeholder="Send a message…"
					disabled={busy}
					onkeydown={(e) => {
						if (e.key === 'Enter' && !e.shiftKey) {
							e.preventDefault();
							void send(e);
						}
					}}
					class="flex-1 resize-none rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm shadow-sm focus:border-neutral-400 focus:outline-none disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900"
				></textarea>
				<button
					type="submit"
					disabled={!composerText.trim() || busy}
					class="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
				>
					Send
				</button>
			</div>
		</form>
	</footer>
</div>
