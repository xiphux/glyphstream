<script lang="ts">
	import { goto } from '$app/navigation';
	import { Download, ImagePlus, RotateCcw, Trash2, X } from '@lucide/svelte';
	import type { MediaConversationRef, MediaListItem } from '$lib/server/db/queries/media';
	import { GALLERY_LAUNCH_KEY, type GalleryLaunchIntent } from '$lib/gallery-launch';

	interface Props {
		/** The media being shown; null means the lightbox is closed (renders nothing). */
		media: MediaListItem | null;
		/** Called when the user closes via Escape, the X button, or backdrop click. */
		onClose: () => void;
		/**
		 * Optional Delete action. Gallery wires this up; in-conversation
		 * tap doesn't (the conversation surface has its own message-level
		 * controls, and exposing destructive media deletion from inside a
		 * chat is the wrong context).
		 */
		onDelete?: (id: string) => void | Promise<void>;
		/** Media id currently being deleted, used to disable the delete button. */
		deletingId?: string | null;
		/**
		 * Optional "conversations referencing this media" section.
		 *  - `undefined`: don't render the section at all (chat-side use case).
		 *  - `null`: render a "Loading…" placeholder (in-flight fetch).
		 *  - `[]`: render "Not used in any conversation" (safe-to-delete signal).
		 *  - `MediaConversationRef[]`: render the list with click-through links.
		 */
		conversationsUsingThis?: MediaConversationRef[] | null;
		conversationsError?: string | null;
		/**
		 * Set to true when the lightbox is mounted inside a conversation
		 * (i.e. the chat-page caller). Adjusts the gallery-launch button
		 * labels to make it explicit that they start a *new* conversation
		 * rather than continuing the one the user is already in — without
		 * this, "Regenerate with this prompt" reads ambiguously, like it
		 * might re-run the generation inside the current chat. From the
		 * gallery surface there's no current conversation to confuse with,
		 * so the default (false) keeps the concise wording.
		 */
		inConversation?: boolean;
	}

	let {
		media,
		onClose,
		onDelete,
		deletingId = null,
		conversationsUsingThis = undefined,
		conversationsError = null,
		inConversation = false,
	}: Props = $props();

	function fmtBytes(n: number): string {
		if (n < 1024) return `${n} B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
		return `${(n / (1024 * 1024)).toFixed(1)} MB`;
	}

	function fmtDate(ms: number): string {
		return new Date(ms).toLocaleString();
	}

	// Escape-to-close lives on window so it works regardless of focus —
	// the lightbox is intentionally a tabindex=-1 dialog (not a focus
	// trap) so the Escape semantic needs to be global. Early-return when
	// no media is open so unrelated keypresses don't reach onClose.
	function onKey(e: KeyboardEvent) {
		if (e.key !== 'Escape') return;
		if (!media) return;
		onClose();
	}

	function sourceModelIdFor(m: MediaListItem): string | null {
		// Compose the internal `endpointId::upstreamId` form the model
		// picker uses. If either piece is missing (legacy uploads, or
		// generations from before the source-model fields were captured)
		// return null and let the new-chat page pick its own default.
		if (!m.sourceEndpointId || !m.sourceModel) return null;
		return `${m.sourceEndpointId}::${m.sourceModel}`;
	}

	function stashIntent(intent: GalleryLaunchIntent): void {
		try {
			window.sessionStorage.setItem(GALLERY_LAUNCH_KEY, JSON.stringify(intent));
		} catch {
			// sessionStorage can throw (private mode, quota, disabled).
			// We don't have a great fallback — proceed with navigation
			// and let the user re-pick on the new-chat page.
		}
	}

	async function regenerateWithPrompt(m: MediaListItem) {
		// promptFull is the primary source; falls back to promptExcerpt
		// for legacy rows whose source conversation was already gone
		// when the 0006 recovery migration ran. Skip silently if there
		// is genuinely no prompt — the button shouldn't render in that
		// case but defense-in-depth.
		const prompt = m.promptFull ?? m.promptExcerpt;
		if (!prompt) return;
		stashIntent({
			kind: 'regenerate',
			prompt,
			sourceModelId: sourceModelIdFor(m),
		});
		onClose();
		await goto('/');
	}

	async function useAsStartingImage(m: MediaListItem) {
		// Videos aren't valid "starting" inputs in v1 — the existing
		// attachments pipeline is image-only. The button is hidden for
		// videos but defense-in-depth.
		if (m.kind !== 'image') return;
		stashIntent({
			kind: 'starting-image',
			mediaId: m.id,
			sourceModelId: sourceModelIdFor(m),
		});
		onClose();
		await goto('/');
	}
</script>

<svelte:window onkeydown={onKey} />

{#if media}
	{@const m = media}
	{@const hasPrompt = (m.promptFull ?? m.promptExcerpt) !== null}
	{@const canUseAsStarting = m.kind === 'image'}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_interactive_supports_focus -->
	<div
		role="dialog"
		aria-modal="true"
		aria-label="Media preview"
		tabindex="-1"
		class="fixed inset-0 z-50 flex flex-col bg-black/90 px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))] backdrop-blur"
		onclick={(e) => {
			// Backdrop-only close: ignore clicks that bubbled from a
			// child (the image, prompt text, conversation list, etc.).
			if (e.target === e.currentTarget) onClose();
		}}
	>
		<div class="flex shrink-0 items-center justify-between gap-3 pb-3 text-sm text-neutral-200">
			<div class="flex flex-col text-xs">
				<span class="font-medium">{m.sourceModel ?? 'Unknown model'}</span>
				<span class="opacity-70">
					{fmtDate(m.createdAt)} · {fmtBytes(m.byteSize)} · {m.contentType}
				</span>
			</div>
			<div class="flex gap-1.5">
				<a
					href="/api/media/{m.id}/content"
					download
					title="Download"
					aria-label="Download"
					class="flex h-8 w-8 items-center justify-center rounded-md border border-neutral-600 bg-neutral-800 text-neutral-200 transition hover:bg-neutral-700"
				>
					<Download size={14} strokeWidth={2.25} />
				</a>
				{#if onDelete}
					<button
						type="button"
						onclick={() => onDelete?.(m.id)}
						disabled={deletingId === m.id}
						title={deletingId === m.id ? 'Deleting…' : 'Delete'}
						aria-label="Delete"
						class="flex h-8 w-8 items-center justify-center rounded-md border border-red-700 bg-red-700 text-white transition hover:bg-red-800 disabled:opacity-50"
					>
						<Trash2 size={14} strokeWidth={2.25} />
					</button>
				{/if}
				<button
					type="button"
					onclick={onClose}
					title="Close"
					aria-label="Close"
					class="flex h-8 w-8 items-center justify-center rounded-md border border-neutral-600 bg-neutral-800 text-neutral-200 transition hover:bg-neutral-700"
				>
					<X size={14} strokeWidth={2.25} />
				</button>
			</div>
		</div>
		<div class="flex flex-1 items-center justify-center overflow-hidden">
			{#if m.kind === 'image'}
				<img
					src="/api/media/{m.id}/content"
					alt={m.promptExcerpt ?? 'Generated image'}
					class="max-h-full max-w-full rounded-lg object-contain"
				/>
			{:else}
				<!-- svelte-ignore a11y_media_has_caption -->
				<video
					src="/api/media/{m.id}/content"
					controls
					autoplay
					playsinline
					class="max-h-full max-w-full rounded-lg"
				></video>
			{/if}
		</div>
		{#if m.promptExcerpt}
			<p class="mx-auto mt-3 max-w-3xl shrink-0 text-center text-xs text-neutral-300 line-clamp-3">
				{m.promptExcerpt}
			</p>
		{/if}
		{#if hasPrompt || canUseAsStarting}
			<!--
				Gallery-launch actions: "Regenerate with this prompt" and
				"Use as starting image" send the user to / pre-loaded with
				the relevant intent (see the LAUNCH_KEY pattern at the top
				of this file). Sit just below the prompt strip so they
				read as actions *on* the prompt and image, not generic
				toolbar buttons — placement matters when the dialog is
				dense. Hidden when there's nothing meaningful to launch
				with (no prompt and not an image).
			-->
			<div class="mx-auto mt-3 flex shrink-0 flex-wrap justify-center gap-2">
				{#if hasPrompt}
					<button
						type="button"
						onclick={() => regenerateWithPrompt(m)}
						title="Start a new conversation pre-filled with this prompt"
						class="inline-flex items-center gap-1.5 rounded-md border border-neutral-600 bg-neutral-800 px-3 py-1.5 text-xs font-medium text-neutral-100 transition hover:bg-neutral-700"
					>
						<RotateCcw size={13} strokeWidth={2.25} />
						{inConversation ? 'Regenerate in a new chat' : 'Regenerate with this prompt'}
					</button>
				{/if}
				{#if canUseAsStarting}
					<button
						type="button"
						onclick={() => useAsStartingImage(m)}
						title="Start a new conversation with this image attached"
						class="inline-flex items-center gap-1.5 rounded-md border border-neutral-600 bg-neutral-800 px-3 py-1.5 text-xs font-medium text-neutral-100 transition hover:bg-neutral-700"
					>
						<ImagePlus size={13} strokeWidth={2.25} />
						{inConversation ? 'Edit in a new chat' : 'Use as starting image'}
					</button>
				{/if}
			</div>
		{/if}
		{#if conversationsUsingThis !== undefined}
			<div class="mx-auto mt-3 w-full max-w-3xl shrink-0 text-xs text-neutral-300">
				{#if conversationsUsingThis === null}
					<p class="text-center opacity-60">Loading conversations…</p>
				{:else if conversationsError}
					<p class="text-center text-red-300">{conversationsError}</p>
				{:else if conversationsUsingThis.length === 0}
					<p class="text-center opacity-60">Not used in any conversation — safe to delete.</p>
				{:else}
					<div class="text-center opacity-60">
						Used in {conversationsUsingThis.length}
						{conversationsUsingThis.length === 1 ? 'conversation' : 'conversations'}:
					</div>
					<ul class="mx-auto mt-1 flex max-h-32 flex-col gap-0.5 overflow-y-auto">
						{#each conversationsUsingThis as c (c.id)}
							<li>
								<a
									href="/chat/{c.id}"
									class="block truncate rounded px-2 py-1 text-center text-neutral-200 hover:bg-neutral-800"
								>
									{c.title ?? 'Untitled'}
									{#if c.archivedAt !== null}
										<span class="ml-1 text-[10px] uppercase tracking-wide opacity-60">
											archived
										</span>
									{/if}
								</a>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		{/if}
	</div>
{/if}
