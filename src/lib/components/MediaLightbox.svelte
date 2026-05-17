<script lang="ts">
	import { Download, Trash2, X } from 'lucide-svelte';
	import type {
		MediaConversationRef,
		MediaListItem
	} from '$lib/server/db/queries/media';

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
	}

	let {
		media,
		onClose,
		onDelete,
		deletingId = null,
		conversationsUsingThis = undefined,
		conversationsError = null
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
</script>

<svelte:window onkeydown={onKey} />

{#if media}
	{@const m = media}
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
					class="max-h-full max-w-full rounded-lg"
				></video>
			{/if}
		</div>
		{#if m.promptExcerpt}
			<p class="mx-auto mt-3 max-w-3xl shrink-0 text-center text-xs text-neutral-300 line-clamp-3">
				{m.promptExcerpt}
			</p>
		{/if}
		{#if conversationsUsingThis !== undefined}
			<div class="mx-auto mt-3 w-full max-w-3xl shrink-0 text-xs text-neutral-300">
				{#if conversationsUsingThis === null}
					<p class="text-center opacity-60">Loading conversations…</p>
				{:else if conversationsError}
					<p class="text-center text-red-300">{conversationsError}</p>
				{:else if conversationsUsingThis.length === 0}
					<p class="text-center opacity-60">
						Not used in any conversation — safe to delete.
					</p>
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
