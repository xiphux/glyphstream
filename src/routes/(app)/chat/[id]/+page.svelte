<script lang="ts">
	import { tick } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { renderLiveMarkdown } from '$lib/markdown-live';
	import { readSSE } from '$lib/sse-client';
	import type {
		ChatMessage,
		MessagePart,
		ModelKind,
		SendMessageResponse,
		StreamEvent
	} from '$lib/types/api';

	let { data } = $props();

	// Read data eagerly so SSR includes messages on first paint; $effect
	// below re-syncs on subsequent navigation invalidation. The warning
	// about capturing the initial value is intentional here — that IS the
	// behavior we want.
	// svelte-ignore state_referenced_locally
	let messages = $state<ChatMessage[]>(data.conversation.messages);
	// svelte-ignore state_referenced_locally
	let title = $state<string | null>(data.conversation.title);
	// svelte-ignore state_referenced_locally
	let modelId = $state(data.conversation.modelId);
	// svelte-ignore state_referenced_locally
	let convId = $state(data.conversation.id);
	// svelte-ignore state_referenced_locally
	let modelKind = $state<ModelKind | null>(data.conversation.modelKind);

	$effect(() => {
		messages = data.conversation.messages;
		title = data.conversation.title;
		modelId = data.conversation.modelId;
		convId = data.conversation.id;
		modelKind = data.conversation.modelKind;
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
	const inFlightHtml = $derived(renderLiveMarkdown(inFlightText));

	// Tick a timer while the in-flight bubble is open so the user gets a
	// progress signal for slow operations (image generation, video gen) and
	// also for chat round-trips that stall before the first token.
	let elapsedSeconds = $state(0);
	$effect(() => {
		if (!inFlightOpen) {
			elapsedSeconds = 0;
			return;
		}
		const startedAt = Date.now();
		elapsedSeconds = 0;
		const interval = setInterval(() => {
			elapsedSeconds = (Date.now() - startedAt) / 1000;
		}, 100);
		return () => clearInterval(interval);
	});

	const inFlightLabel = $derived(
		modelKind === 'image'
			? 'Generating image'
			: modelKind === 'video'
				? 'Generating video'
				: 'Thinking'
	);

	async function sendStreaming(text: string) {
		busy = true;
		errorMsg = null;
		inFlightText = '';
		inFlightReasoning = '';
		inFlightOpen = true;

		// Image-kind conversations use the sync JSON path — there's nothing
		// to stream (one-shot generate). Chat-kind streams via SSE.
		if (modelKind === 'image') {
			await sendImageGeneration(text);
			return;
		}

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

	async function sendImageGeneration(text: string) {
		try {
			const res = await fetch(`/api/conversations/${convId}/messages`, {
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
			inFlightOpen = false;
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

	function hasMedia(parts: MessagePart[]): boolean {
		return parts.some((p) => p.type === 'image' || p.type === 'video');
	}

	function partKey(p: MessagePart): string {
		if (p.type === 'image' || p.type === 'video') return p.mediaId;
		return p.type + ':' + ('text' in p ? p.text.slice(0, 8) : '');
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
							? hasMedia(m.parts)
								? 'w-fit max-w-full bg-neutral-100 dark:bg-neutral-800'
								: 'bg-neutral-100 dark:bg-neutral-800'
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
					{#if m.role === 'assistant' && m.contentHtml}
						<!-- HTML is server-rendered (markdown-it w/ html=false + shiki); safe to {@html}. -->
						<div class="gs-prose mt-1">{@html m.contentHtml}</div>
					{:else if hasMedia(m.parts)}
						<div class="mt-2 flex flex-wrap gap-2">
							{#each m.parts as p (partKey(p))}
								{#if p.type === 'image'}
									<a
										href="/api/media/{p.mediaId}/content"
										target="_blank"
										rel="noopener noreferrer"
										class="block overflow-hidden rounded-lg"
									>
										<img
											src="/api/media/{p.mediaId}/content"
											alt={p.alt ?? 'Generated image'}
											loading="lazy"
											class="max-h-96 max-w-full rounded-lg"
										/>
									</a>
								{:else if p.type === 'video'}
									<!-- svelte-ignore a11y_media_has_caption -->
									<video
										src="/api/media/{p.mediaId}/content"
										controls
										class="max-h-96 max-w-full rounded-lg"
									></video>
								{/if}
							{/each}
						</div>
					{:else}
						<div class="mt-1 whitespace-pre-wrap break-words">
							{partsToText(m.parts)}
						</div>
					{/if}
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
					{#if inFlightText}
						<div class="gs-prose mt-1">{@html inFlightHtml}</div>
					{:else if !inFlightReasoning}
						<div class="mt-1 flex items-center gap-2 text-neutral-500">
							<span>{inFlightLabel}</span>
							<span class="inline-flex gap-1">
								<span class="animate-pulse">·</span>
								<span class="animate-pulse [animation-delay:120ms]">·</span>
								<span class="animate-pulse [animation-delay:240ms]">·</span>
							</span>
							{#if elapsedSeconds >= 0.3}
								<span class="font-mono text-xs tabular-nums">{elapsedSeconds.toFixed(1)}s</span>
							{/if}
						</div>
					{/if}
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
					placeholder={modelKind === 'image' ? 'Describe an image to generate…' : 'Send a message…'}
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
