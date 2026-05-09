<script lang="ts">
	import { tick } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { readSSE } from '$lib/sse-client';
	import type {
		ChatMessage,
		MessagePart,
		StreamEvent
	} from '$lib/types/api';

	let { data } = $props();

	let messages = $state<ChatMessage[]>([]);
	let title = $state<string | null>(null);
	let modelId = $state('');
	let convId = $state('');

	$effect(() => {
		messages = data.conversation.messages;
		title = data.conversation.title;
		modelId = data.conversation.modelId;
		convId = data.conversation.id;
	});

	let composerText = $state('');
	let busy = $state(false);
	let errorMsg = $state<string | null>(null);
	let scrollContainer = $state<HTMLElement | null>(null);

	// In-flight assistant render state. While streaming we show a transient
	// "assistant" bubble that isn't yet a row in the messages array; on `done`
	// we splice the canonical persisted ChatMessage into messages.
	let inFlightText = $state('');
	let inFlightReasoning = $state('');
	let inFlightOpen = $state(false);

	async function sendStreaming(text: string) {
		busy = true;
		errorMsg = null;
		inFlightText = '';
		inFlightReasoning = '';
		inFlightOpen = true;

		try {
			const res = await fetch(`/api/conversations/${convId}/messages?stream=1`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Accept: 'text/event-stream'
				},
				body: JSON.stringify({ text })
			});
			if (!res.ok) {
				const j = await res.json().catch(() => ({}));
				throw new Error(j.message ?? `HTTP ${res.status}`);
			}
			if (!res.body) throw new Error('Server returned no body');

			for await (const rec of readSSE(res.body)) {
				let event: StreamEvent;
				try {
					event = JSON.parse(rec.data) as StreamEvent;
				} catch {
					continue;
				}
				switch (event.type) {
					case 'start':
						messages = [...messages, event.userMessage];
						await tick();
						scrollToBottom();
						break;
					case 'text':
						inFlightText += event.chunk;
						scrollToBottom();
						break;
					case 'reasoning':
						inFlightReasoning += event.chunk;
						scrollToBottom();
						break;
					case 'done':
						messages = [...messages, event.assistantMessage];
						inFlightOpen = false;
						inFlightText = '';
						inFlightReasoning = '';
						break;
					case 'error':
						errorMsg = event.message;
						inFlightOpen = false;
						break;
				}
			}
			void invalidateAll();
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : String(e);
			inFlightOpen = false;
		} finally {
			busy = false;
		}
	}

	async function send(e: Event) {
		e.preventDefault();
		const text = composerText.trim();
		if (!text || busy) return;
		composerText = '';
		await sendStreaming(text);
	}

	function scrollToBottom() {
		if (scrollContainer) {
			scrollContainer.scrollTop = scrollContainer.scrollHeight;
		}
	}

	$effect(() => {
		void messages.length;
		void inFlightText;
		void tick().then(scrollToBottom);
	});

	// First-message handoff from /(app)/+page.svelte: when the new-chat page
	// creates a conversation, it stashes the first message in sessionStorage
	// and navigates here so the response can stream in this page's lifecycle.
	let bootstrapped = $state(false);
	$effect(() => {
		if (bootstrapped || typeof window === 'undefined' || busy) return;
		const key = `glyphstream:pendingFirstMessage:${convId}`;
		const pending = window.sessionStorage.getItem(key);
		if (pending) {
			window.sessionStorage.removeItem(key);
			bootstrapped = true;
			void sendStreaming(pending);
		}
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
					{#if m.reasoningText}
						<details class="mt-1 rounded-md border border-neutral-300 bg-white p-2 text-xs dark:border-neutral-700 dark:bg-neutral-900">
							<summary class="cursor-pointer text-neutral-500">Reasoning</summary>
							<div class="mt-2 whitespace-pre-wrap break-words text-neutral-700 dark:text-neutral-300">
								{m.reasoningText}
							</div>
						</details>
					{/if}
					<div class="mt-1 whitespace-pre-wrap break-words">
						{partsToText(m.parts)}
					</div>
				</article>
			{/each}

			{#if inFlightOpen}
				<article class="rounded-2xl bg-neutral-100 px-4 py-3 text-sm dark:bg-neutral-800">
					<div class="text-[11px] uppercase tracking-wide opacity-60">assistant</div>
					{#if inFlightReasoning}
						<details open class="mt-1 rounded-md border border-neutral-300 bg-white p-2 text-xs dark:border-neutral-700 dark:bg-neutral-900">
							<summary class="cursor-pointer text-neutral-500">Reasoning</summary>
							<div class="mt-2 whitespace-pre-wrap break-words text-neutral-700 dark:text-neutral-300">
								{inFlightReasoning}
							</div>
						</details>
					{/if}
					<div class="mt-1 whitespace-pre-wrap break-words">
						{inFlightText}
						{#if !inFlightText && !inFlightReasoning}
							<span class="inline-flex gap-1 align-middle">
								<span class="animate-pulse">·</span>
								<span class="animate-pulse [animation-delay:120ms]">·</span>
								<span class="animate-pulse [animation-delay:240ms]">·</span>
							</span>
						{/if}
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
