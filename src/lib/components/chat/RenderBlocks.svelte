<!--
	Shared body renderer for chat bubbles. Both the persisted message
	view (MessageBubble) and the live streaming view (InFlightBubble)
	convert their state into the same RenderBlock[] shape (see
	chat-render.ts) and draw them here — one place for the structural
	rendering of reasoning / text / tool calls / media so the
	live-streaming view and the canonical post-reload view never drift.
	Add a new content type once here, get it in both.
-->
<script lang="ts">
	import ToolCallBlock from '$lib/components/ToolCallBlock.svelte';
	import FileAttachmentChip from '$lib/components/FileAttachmentChip.svelte';
	import type { RenderBlock } from '$lib/chat-render';

	type ApprovalAction = 'allow' | 'allow_always' | 'reject';

	interface Props {
		blocks: RenderBlock[];
		/** Invoked when an image block is clicked (opens the lightbox). */
		onImageClick: (mediaId: string) => void;
		/** Media id currently being fetched for the lightbox; its image
		 *  button is disabled to avoid a double-open race. */
		openingLightboxFor?: string | null;
		/** Per-tool decisions the user has staged. Pending tool blocks
		 *  read their own toolCallId out of this map to highlight the
		 *  selected button. */
		approvalDecisions?: Map<string, ApprovalAction>;
		approvalBusy?: boolean;
		onApprovalSelect?: (toolCallId: string, action: ApprovalAction) => void;
	}

	let {
		blocks,
		onImageClick,
		openingLightboxFor = null,
		approvalDecisions,
		approvalBusy = false,
		onApprovalSelect,
	}: Props = $props();

	function blockKey(b: RenderBlock, i: number): string {
		if (b.type === 'tool_call') return 'tool_call:' + b.toolCallId;
		if (b.type === 'image' || b.type === 'video' || b.type === 'file') {
			return b.type + ':' + b.mediaId;
		}
		return b.type + ':' + i;
	}
</script>

{#each blocks as block, i (blockKey(block, i))}
	{#if block.type === 'reasoning'}
		<details
			open={block.open}
			class="mt-1 rounded-md border border-border-strong bg-surface-panel p-2 text-xs"
		>
			<summary class="cursor-pointer text-fg-muted">Reasoning</summary>
			<div class="mt-2 whitespace-pre-wrap break-words text-fg-secondary">
				{block.text}
			</div>
		</details>
	{:else if block.type === 'html'}
		<!-- HTML is either server-rendered (shiki, persisted assistant)
		     or client-rendered via renderLiveMarkdown (in-flight).
		     Both pass through markdown-it with html=false; safe to {@html}. -->
		<div class="gs-prose mt-1">{@html block.html}</div>
	{:else if block.type === 'plain-text'}
		<div class="mt-1 whitespace-pre-wrap break-words">{block.text}</div>
	{:else if block.type === 'tool_call'}
		<ToolCallBlock
			toolName={block.toolName}
			argumentsJson={block.arguments}
			argumentsHtml={block.argsHtml}
			result={block.result}
			isError={block.isError}
			status={block.status}
			attachments={block.attachments}
			toolCallId={block.toolCallId}
			decision={approvalDecisions?.get(block.toolCallId) ?? null}
			{approvalBusy}
			{onApprovalSelect}
		/>
	{:else if block.type === 'image'}
		{@const mediaId = block.mediaId}
		<button
			type="button"
			onclick={() => onImageClick(mediaId)}
			aria-label="Open image"
			class="mt-2 block w-full overflow-hidden rounded-lg p-0 text-left transition disabled:opacity-60"
			disabled={openingLightboxFor === mediaId}
		>
			<img
				src="/api/media/{block.mediaId}/content"
				alt={block.alt ?? 'Image'}
				loading="lazy"
				class="block h-auto w-full max-h-[80vh] rounded-lg object-contain"
			/>
		</button>
	{:else if block.type === 'video'}
		<!-- svelte-ignore a11y_media_has_caption -->
		<video
			src="/api/media/{block.mediaId}/content"
			controls
			class="mt-2 block h-auto w-full max-h-[80vh] rounded-lg"
		></video>
	{:else if block.type === 'file'}
		<div class="mt-2">
			<FileAttachmentChip
				filename={block.filename}
				byteSize={block.byteSize}
				href={`/api/media/${block.mediaId}/content`}
			/>
		</div>
	{/if}
{/each}
