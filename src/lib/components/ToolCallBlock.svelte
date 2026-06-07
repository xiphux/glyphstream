<script lang="ts">
	/**
	 * Folded tool-call display block. One per `tool_call` part on an
	 * assistant message; the matching `tool_result` (looked up from the
	 * sibling-map of folded role:'tool' messages) supplies the result
	 * + status.
	 *
	 * Layout mirrors the reasoning <details> block in the chat page:
	 * native disclosure triangle, muted small-caps label, monospace
	 * function name, status badge on the right. Collapsed by default
	 * when the call is done; auto-expanded while executing.
	 */
	import type { Snippet } from 'svelte';
	import { Check, ShieldCheck, ShieldX } from '@lucide/svelte';
	import FileAttachmentChip from '$lib/components/FileAttachmentChip.svelte';
	import { extractCodeArg, type ToolResultAttachment } from '$lib/chat-render';
	import {
		highlightLiveCode,
		liveHighlighterReady,
		resolveLiveLang,
	} from '$lib/markdown-live-shiki.svelte';
	import type { ApprovalAction } from '$lib/approval-workflow';

	type Status = 'executing' | 'done' | 'error' | 'pending_approval';

	interface Props {
		toolName: string;
		argumentsJson: string;
		/** Pre-rendered HTML for tools whose primary argument is source
		 *  code (today: run_python — the code parameter rendered through
		 *  the same shiki pipeline as assistant message bodies). When
		 *  present, replaces the JSON pretty-print under "Arguments" so
		 *  Python reads as syntax-highlighted Python, not a stringified
		 *  JSON blob. Server-only path; live-streaming view falls back to
		 *  argumentsJson because the args are still arriving as a JSON
		 *  blob then. */
		argumentsHtml?: string;
		/** undefined while the tool is still executing. */
		result?: string;
		isError?: boolean;
		status: Status;
		/** Optional slot for callers that want to add a status suffix
		 *  (elapsed time, etc.). Renders inside the badge. */
		badgeSuffix?: Snippet;
		/** Only meaningful when status === 'pending_approval'. The
		 *  toolCallId so the click handler can identify which pending row
		 *  to update. */
		toolCallId?: string;
		/** Whichever decision the user has staged for this call (when N
		 *  pending tools are on screen, each independently records its
		 *  user-chosen action; the chat page auto-submits the batch once
		 *  every pending tool has a non-null decision). */
		decision?: ApprovalAction | null;
		approvalBusy?: boolean;
		onApprovalSelect?: (toolCallId: string, action: ApprovalAction) => void;
		/** Media the tool produced — rendered as inline image / video /
		 *  download chip after the result, so the user sees the artifact
		 *  attached to the same block as the call that produced it. */
		attachments?: ToolResultAttachment[];
	}

	let {
		toolName,
		argumentsJson,
		argumentsHtml,
		result,
		isError,
		status,
		badgeSuffix,
		toolCallId,
		decision = null,
		approvalBusy = false,
		onApprovalSelect,
		attachments,
	}: Props = $props();

	// Pretty-print JSON when it parses; otherwise the raw string. Cheap
	// even on large args because the args themselves are typically tiny
	// (a single function call's argument payload).
	function prettyJson(s: string | undefined): string {
		if (!s) return '';
		try {
			return JSON.stringify(JSON.parse(s), null, 2);
		} catch {
			return s;
		}
	}

	const prettyArgs = $derived(prettyJson(argumentsJson));
	const prettyResult = $derived(prettyJson(result));

	// Streaming-tolerant code extraction. While the server hasn't yet
	// produced argumentsHtml (mid-stream, or pre-shiki for whatever
	// reason), if the tool is one whose primary argument is source
	// code (today: run_python), pull just the code out of the partial
	// JSON envelope so the user sees actual newlined source instead of
	// a one-liner like `{"code":"import pandas\\nimport ..."}`. Returns
	// null for non-code tools and for envelopes that don't yet contain
	// the code field — those fall through to the JSON pretty-print.
	const streamingCode = $derived(argumentsHtml ? null : extractCodeArg(toolName, argumentsJson));

	// Upgrade mid-stream code to client-side shiki the moment the lazy
	// highlighter chunk lands. Reading `liveHighlighterReady.value`
	// makes this $derived re-run on load. Returns null while the chunk
	// is still in flight or for languages outside the client subset
	// (today only python is wired to be reachable here), and the
	// template falls back to plain monospace.
	const streamingCodeHtml = $derived.by(() => {
		if (!streamingCode) return null;
		if (!liveHighlighterReady.value) return null;
		const lang = resolveLiveLang(streamingCode.language);
		if (!lang) return null;
		return highlightLiveCode(streamingCode.code, lang);
	});

	// Collapsed by default when the call is done — tool details are
	// metadata for the curious, not primary content. Auto-expanded
	// while executing so the user sees activity. Errors stay expanded
	// because the user typically WANTS to see what went wrong. Pending-
	// approval rows stay expanded so the prompt + args are visible.
	const openByDefault = $derived(
		status === 'executing' || status === 'error' || status === 'pending_approval',
	);

	const badgeColorClass = $derived(
		status === 'executing'
			? 'text-warning'
			: status === 'error'
				? 'text-danger'
				: status === 'pending_approval'
					? 'text-warning'
					: 'text-success',
	);

	function approvalButtonClass(action: ApprovalAction): string {
		const base =
			'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-medium transition disabled:cursor-not-allowed disabled:opacity-50';
		const selected = decision === action;
		switch (action) {
			case 'allow':
				return `${base} ${selected ? 'border-success/50 bg-success/10 text-success' : 'border-border bg-surface-panel text-fg hover:bg-surface-raised'}`;
			case 'allow_always':
				return `${base} ${selected ? 'border-info/50 bg-info/10 text-info' : 'border-border bg-surface-panel text-fg hover:bg-surface-raised'}`;
			case 'reject':
				return `${base} ${selected ? 'border-danger/50 bg-danger/10 text-danger' : 'border-border bg-surface-panel text-fg hover:bg-surface-raised'}`;
		}
	}
</script>

<details
	open={openByDefault}
	class="mt-2 rounded-md border border-border-strong bg-surface-panel text-xs"
>
	<summary class="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-fg-muted select-none">
		<span class="text-[10px] font-semibold uppercase tracking-wider opacity-70">Tool</span>
		<span class="font-mono text-xs text-fg-secondary">{toolName}</span>
		<span class="flex-1"></span>
		<!--
			Status badge only shows for non-default states. A completed call
			renders no badge — the disclosure triangle on the summary line
			communicates the call exists; users assume done unless told
			otherwise. Errors and in-progress stay visible because they're
			the cases the user actually wants to notice at a glance.
		-->
		{#if status !== 'done'}
			<span
				class="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide {badgeColorClass}"
			>
				{#if status === 'executing'}
					<span class="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current"></span>
					running
				{:else if status === 'pending_approval'}
					<ShieldCheck size={12} strokeWidth={2.5} aria-hidden="true" />
					needs approval
				{:else}
					error
				{/if}
				{#if badgeSuffix}<span class="opacity-70 normal-case">{@render badgeSuffix()}</span>{/if}
			</span>
		{/if}
	</summary>
	<div class="space-y-2 border-t border-border p-2">
		{#if argumentsHtml}
			<!--
				Server-rendered code (today: run_python's `code` arg
				through shiki, same pipeline as assistant message bodies).
				Inherits the existing .gs-prose styling so the code block
				visually matches the rest of the chat. {@html} is safe
				here: the source went through markdown-it with html=false
				and our shiki-driven renderer, so it's structurally
				whitelisted before reaching the DOM.
			-->
			<div class="gs-prose text-xs">{@html argumentsHtml}</div>
		{:else if streamingCode}
			<!--
				Mid-stream code rendering. Two paths:
				1. The lazy client-side shiki chunk has loaded AND the
				   language is in its subset (today: python) — render
				   the highlighted HTML directly, same look as the
				   eventual server render so there's no
				   unhighlighted→highlighted flash when persistence
				   swaps in argumentsHtml.
				2. Otherwise — chunk still in flight, or language outside
				   the subset — render plain monospace with newlines
				   preserved. The server's full highlight lands later
				   and takes over via argumentsHtml.
			-->
			<div>
				<div class="mb-0.5 text-[10px] font-medium uppercase tracking-wider text-fg-muted">
					{streamingCode.language}
				</div>
				{#if streamingCodeHtml}
					<div class="gs-prose text-xs">{@html streamingCodeHtml}</div>
				{:else}
					<pre
						class="overflow-x-auto whitespace-pre break-normal font-mono text-[11px] text-fg-secondary">{streamingCode.code}</pre>
				{/if}
			</div>
		{:else if prettyArgs}
			<div>
				<div class="mb-0.5 text-[10px] font-medium uppercase tracking-wider text-fg-muted">
					Arguments
				</div>
				<pre
					class="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] text-fg-secondary">{prettyArgs}</pre>
			</div>
		{/if}
		{#if status === 'pending_approval'}
			<div class="rounded border-l-2 border-warning pl-2">
				<div class="mb-0.5 text-[10px] font-medium uppercase tracking-wider text-warning">
					Awaiting your approval
				</div>
				<div class="flex flex-wrap gap-1.5 pb-1 pt-0.5">
					<button
						type="button"
						class={approvalButtonClass('allow')}
						disabled={approvalBusy || !onApprovalSelect || !toolCallId}
						onclick={() => toolCallId && onApprovalSelect && onApprovalSelect(toolCallId, 'allow')}
					>
						<Check size={12} strokeWidth={2.5} aria-hidden="true" />
						Allow
					</button>
					<button
						type="button"
						class={approvalButtonClass('allow_always')}
						disabled={approvalBusy || !onApprovalSelect || !toolCallId}
						onclick={() =>
							toolCallId && onApprovalSelect && onApprovalSelect(toolCallId, 'allow_always')}
					>
						<ShieldCheck size={12} strokeWidth={2.5} aria-hidden="true" />
						Allow always
					</button>
					<button
						type="button"
						class={approvalButtonClass('reject')}
						disabled={approvalBusy || !onApprovalSelect || !toolCallId}
						onclick={() => toolCallId && onApprovalSelect && onApprovalSelect(toolCallId, 'reject')}
					>
						<ShieldX size={12} strokeWidth={2.5} aria-hidden="true" />
						Reject
					</button>
				</div>
			</div>
		{:else if result !== undefined}
			<div class="rounded {isError ? 'border-l-2 border-danger pl-2' : ''}">
				<div
					class="mb-0.5 text-[10px] font-medium uppercase tracking-wider {isError
						? 'text-danger'
						: 'text-fg-muted'}"
				>
					{isError ? 'Error' : 'Result'}
				</div>
				<pre
					class="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] text-fg-secondary">{prettyResult}</pre>
			</div>
		{/if}
	</div>
</details>
<!--
	Generated attachments live OUTSIDE the <details> so they stay
	visible even when the tool block auto-collapses (status: 'done').
	A file the model just produced is the kind of artifact the user
	wants to see immediately — if it were hidden inside the collapsed
	block, the assistant's "here's the file" sentence would point at
	nothing the user can click on, which surfaced as a real UX gap
	in early smoke testing.
-->
{#if attachments && attachments.length > 0}
	<div class="mt-2 flex flex-wrap gap-2">
		{#each attachments as att (att.mediaId)}
			{#if att.type === 'image'}
				<img
					src="/api/media/{att.mediaId}/content"
					alt=""
					loading="lazy"
					class="block h-auto max-h-[60vh] w-auto max-w-full rounded-md"
				/>
			{:else if att.type === 'video'}
				<!-- svelte-ignore a11y_media_has_caption -->
				<video
					src="/api/media/{att.mediaId}/content"
					controls
					playsinline
					class="block h-auto max-h-[60vh] w-auto max-w-full rounded-md"
				></video>
			{:else}
				<FileAttachmentChip
					filename={att.filename}
					byteSize={att.byteSize}
					href={`/api/media/${att.mediaId}/content`}
				/>
			{/if}
		{/each}
	</div>
{/if}
