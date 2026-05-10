<script lang="ts">
	import { tick } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { ArrowUp, Check, Copy, Square } from 'lucide-svelte';
	import { firstName } from '$lib/greeting';
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

	// Friendly bubble labels: the user's first name + the model's friendly
	// name (server resolves custom-model name when applicable).
	const userLabel = $derived(
		firstName(data.user.displayName, data.user.githubUsername)
	);
	const assistantLabel = $derived(data.assistantLabel);

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

	// Auto-resize textarea: grow with content up to a sensible max so
	// long-form composition gets the room it needs without pushing the
	// message list off-screen on small phones.
	let composerEl = $state<HTMLTextAreaElement | null>(null);
	const COMPOSER_MAX_HEIGHT_PX = 240;
	$effect(() => {
		const el = composerEl;
		void composerText; // re-run on every keystroke
		if (!el) return;
		// Reset to "auto" first so scrollHeight reflects the content's
		// natural height instead of a previously-set larger value.
		el.style.height = 'auto';
		const next = Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT_PX);
		el.style.height = `${next}px`;
		el.style.overflowY = el.scrollHeight > COMPOSER_MAX_HEIGHT_PX ? 'auto' : 'hidden';
	});

	// AbortController for the in-flight fetch. Stop button click triggers
	// .abort() AND fires a POST to /api/conversations/:id/cancel so the
	// server tears down upstream too (otherwise the bridge keeps generating).
	let activeAbort = $state<AbortController | null>(null);

	// In-flight assistant render state. While streaming we show a transient
	// "assistant" bubble that isn't yet a row in the messages array; on `done`
	// we splice the canonical persisted ChatMessage into messages.
	let inFlightText = $state('');
	let inFlightReasoning = $state('');
	let inFlightOpen = $state(false);
	let inFlightProgress = $state<number | null>(null);
	let inFlightStatus = $state<string | null>(null);
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
		inFlightProgress = null;
		inFlightStatus = null;
		inFlightOpen = true;

		// Image-kind conversations use the sync JSON path — there's nothing
		// to stream (one-shot generate). Chat and video both stream via SSE
		// (chat for tokens, video for poll-based progress events).
		if (modelKind === 'image') {
			await sendImageGeneration(text);
			return;
		}

		const abort = new AbortController();
		activeAbort = abort;
		try {
			const res = await fetch(`/api/conversations/${convId}/messages?stream=1`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Accept: 'text/event-stream'
				},
				body: JSON.stringify({ text }),
				signal: abort.signal
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
					case 'progress':
						inFlightProgress = event.percent;
						inFlightStatus = event.status ?? null;
						break;
					case 'done':
						messages = [...messages, event.assistantMessage];
						inFlightOpen = false;
						inFlightText = '';
						inFlightReasoning = '';
						inFlightProgress = null;
						inFlightStatus = null;
						break;
					case 'error':
						errorMsg = event.message;
						inFlightOpen = false;
						inFlightProgress = null;
						inFlightStatus = null;
						break;
				}
			}
			void invalidateAll();
		} catch (e) {
			// AbortError from clicking Stop is expected — don't surface as
			// a user-facing error. The server-side recorder will have committed
			// whatever partial text it had; invalidateAll picks that up.
			if (isAbortError(e)) {
				void invalidateAll();
			} else {
				errorMsg = e instanceof Error ? e.message : String(e);
			}
			inFlightOpen = false;
		} finally {
			busy = false;
			activeAbort = null;
		}
	}

	async function sendImageGeneration(text: string) {
		const abort = new AbortController();
		activeAbort = abort;
		try {
			const res = await fetch(`/api/conversations/${convId}/messages`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ text }),
				signal: abort.signal
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
			if (isAbortError(e)) {
				void invalidateAll();
			} else {
				errorMsg = e instanceof Error ? e.message : String(e);
			}
			inFlightOpen = false;
		} finally {
			busy = false;
			activeAbort = null;
		}
	}

	async function stop() {
		const abort = activeAbort;
		if (!abort) return;
		// Tell the server to tear down upstream first (so the bridge stops
		// generating instead of running to completion). Then abort the local
		// fetch so we stop receiving the in-flight events.
		try {
			await fetch(`/api/conversations/${convId}/cancel`, { method: 'POST' });
		} catch {
			// Best-effort — even if the cancel POST fails, aborting locally
			// still gives the user the "stopped" UX.
		}
		abort.abort();
	}

	function isAbortError(e: unknown): boolean {
		if (e instanceof DOMException && e.name === 'AbortError') return true;
		if (e instanceof Error && e.name === 'AbortError') return true;
		return false;
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

	// Copy-to-clipboard. Tracks the most recently copied message id so the
	// trigger icon can briefly swap to a check mark as feedback. We use a
	// single id slot rather than a per-message map because only one copy
	// confirmation is on screen at a time.
	let recentlyCopiedId = $state<string | null>(null);
	let copyTimer: ReturnType<typeof setTimeout> | null = null;

	async function copyMessage(m: ChatMessage) {
		const text = partsToText(m.parts);
		if (!text) return;
		try {
			await navigator.clipboard.writeText(text);
			recentlyCopiedId = m.id;
			if (copyTimer) clearTimeout(copyTimer);
			copyTimer = setTimeout(() => {
				if (recentlyCopiedId === m.id) recentlyCopiedId = null;
				copyTimer = null;
			}, 1500);
		} catch (e) {
			// clipboard.writeText can reject in non-secure contexts (HTTP) or
			// when the document isn't focused. Surface to console; the user
			// will see no feedback and can try again.
			console.warn('Copy to clipboard failed:', e);
		}
	}

	/** Whether to show the action bar for a message — only when there's
	 * something copyable. Skip for media-only messages with no text. */
	function hasCopyableText(m: ChatMessage): boolean {
		return partsToText(m.parts).trim().length > 0;
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
	<header class="flex items-center justify-between px-4 py-3">
		<div class="min-w-0 flex-1">
			<h1 class="truncate text-sm font-semibold">{title ?? 'Untitled chat'}</h1>
			<p class="truncate text-xs text-neutral-500">{assistantLabel}</p>
		</div>
	</header>

	<!--
		Bottom mask-fade so message content dissolves into the page bg
		just before reaching the composer, instead of meeting it with a
		hard rectangular edge. ~32px fade is enough to soften the seam
		without cutting off readable content. Pure CSS mask-image — no JS,
		works the same on every browser that supports CSS Masking L1.
	-->
	<div
		bind:this={scrollContainer}
		class="flex-1 overflow-y-auto px-4 py-4 [mask-image:linear-gradient(to_bottom,black_calc(100%-32px),transparent)]"
	>
		<div class="mx-auto max-w-3xl space-y-4">
			{#each messages as m (m.id)}
				<!--
					Message + action-bar group. The actions row sits directly
					below the bubble, aligned to the same side (right for user
					messages, left for assistant), and reveals on hover at sm+.
					On mobile it stays visible since there's no hover.
				-->
				<div class="group">
				<article
					class="rounded-2xl px-4 py-3 text-sm {m.role === 'user'
						? 'ml-auto max-w-[85%] bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
						: m.role === 'assistant'
							? 'bg-neutral-100 dark:bg-neutral-800'
							: 'bg-amber-50 dark:bg-amber-950/40'}"
				>
					<div class="text-[11px] font-medium tracking-wide opacity-60">
						{m.role === 'user' ? userLabel : m.role === 'assistant' ? assistantLabel : m.role}
					</div>
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
						<div class="mt-2 space-y-2">
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
											class="block h-auto w-full max-h-[80vh] rounded-lg object-contain"
										/>
									</a>
								{:else if p.type === 'video'}
									<!-- svelte-ignore a11y_media_has_caption -->
									<video
										src="/api/media/{p.mediaId}/content"
										controls
										class="block h-auto w-full max-h-[80vh] rounded-lg"
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
				{#if hasCopyableText(m)}
					{@const justCopied = recentlyCopiedId === m.id}
					<div
						class="mt-1 flex opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 {m.role ===
						'user'
							? 'justify-end'
							: 'justify-start'}"
					>
						<button
							type="button"
							onclick={() => copyMessage(m)}
							aria-label={justCopied ? 'Copied' : 'Copy message'}
							title={justCopied ? 'Copied' : 'Copy'}
							class="flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-200 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
						>
							{#if justCopied}
								<Check size={14} strokeWidth={2.25} class="text-emerald-600 dark:text-emerald-400" />
							{:else}
								<Copy size={14} strokeWidth={2.25} />
							{/if}
						</button>
					</div>
				{/if}
				</div>
			{/each}

			{#if inFlightOpen}
				<article class="rounded-2xl bg-neutral-100 px-4 py-3 text-sm dark:bg-neutral-800">
					<div class="text-[11px] font-medium tracking-wide opacity-60">{assistantLabel}</div>
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
							{#if inFlightStatus && inFlightStatus !== 'in_progress'}
								<span class="rounded bg-neutral-200 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200">
									{inFlightStatus}
								</span>
							{/if}
							{#if inFlightProgress !== null}
								<span class="font-mono text-xs tabular-nums">{inFlightProgress.toFixed(0)}%</span>
							{/if}
							{#if elapsedSeconds >= 0.3}
								<span class="font-mono text-xs tabular-nums">{elapsedSeconds.toFixed(1)}s</span>
							{/if}
						</div>
					{/if}
				</article>
			{/if}
		</div>
	</div>

	<!-- Floating composer. Sits above the scrollable message area without
		 a separator border — reads as part of the chat surface. The form
		 itself is the rounded box; no surrounding footer chrome. -->
	<div class="px-4 pb-4">
		<form onsubmit={send} class="mx-auto max-w-3xl">
			{#if errorMsg}
				<div
					class="mb-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200"
				>
					{errorMsg}
				</div>
			{/if}
			<div class="rounded-2xl border border-neutral-300 bg-white px-3 py-2 shadow-sm transition focus-within:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900 dark:focus-within:border-neutral-500">
				<textarea
					bind:this={composerEl}
					bind:value={composerText}
					rows="1"
					placeholder={modelKind === 'image' ? 'Describe an image to generate…' : 'Write a message…'}
					disabled={busy}
					onkeydown={(e) => {
						if (e.key === 'Enter' && !e.shiftKey) {
							e.preventDefault();
							void send(e);
						}
					}}
					class="block w-full resize-none border-0 bg-transparent px-2 py-2 text-sm focus:outline-none disabled:opacity-50"
				></textarea>
				<div class="flex items-center justify-end gap-2 px-1 pt-1">
					{#if busy && activeAbort}
						<button
							type="button"
							onclick={stop}
							aria-label="Stop generation"
							title="Stop"
							class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-red-600 text-white transition hover:bg-red-700 dark:bg-red-700 dark:hover:bg-red-600"
						>
							<Square size={14} strokeWidth={2.5} fill="currentColor" />
						</button>
					{:else}
						<button
							type="submit"
							disabled={!composerText.trim() || busy}
							aria-label="Send message"
							title="Send"
							class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-white transition hover:bg-neutral-800 disabled:opacity-30 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
						>
							<ArrowUp size={16} strokeWidth={2.5} />
						</button>
					{/if}
				</div>
			</div>
		</form>
	</div>
</div>
