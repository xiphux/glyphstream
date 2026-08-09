<!--
	Code-argument tool block (today: run_python). Renders the source-code arg as
	highlighted code instead of a JSON blob: server-rendered `argumentsHtml`
	(shiki, persisted) when present, else the client-extracted streaming code
	(optionally client-shiki-highlighted once the lazy chunk lands), else the JSON
	args fallback. Plus the result/error section.
-->
<script lang="ts">
	import ToolBlockShell from './ToolBlockShell.svelte';
	import ToolResultSection from './ToolResultSection.svelte';
	import { extractCodeArg, prettyJson, type ToolResultAttachment } from '$lib/chat-render';
	import {
		highlightLiveCode,
		liveHighlighterReady,
		resolveLiveLang,
	} from '$lib/markdown-live-shiki.svelte';

	type Status = 'executing' | 'done' | 'error' | 'pending_approval';

	interface Props {
		toolName: string;
		argumentsJson: string;
		argumentsHtml?: string;
		result?: string;
		isError?: boolean;
		status: Status;
		attachments?: ToolResultAttachment[];
	}

	let { toolName, argumentsJson, argumentsHtml, result, isError, status, attachments }: Props =
		$props();

	// All read only inside the body snippet (lazy gate).
	const prettyArgs = $derived(prettyJson(argumentsJson));
	// Mid-stream: pull the code field out of partial JSON so it reads as source,
	// not a one-line `{"code":"…"}` blob. Null once argumentsHtml (server shiki)
	// is present, or for non-code tools / not-yet-arrived code fields.
	const streamingCode = $derived(argumentsHtml ? null : extractCodeArg(toolName, argumentsJson));
	// Upgrade the code to client-side shiki once the call settles — NOT while its
	// arguments are still arriving.
	//
	// The relay emits one `tool_call_args_delta` per upstream chunk, and unlike
	// the assistant text path this one has no rAF coalescing, so a derived that
	// highlights `streamingCode.code` re-tokenized the *entire* accumulated
	// source on every delta. Cost is O(tokens x final size): a 200-line program
	// arriving over ~1200 deltas spends ~7ms per highlight on average and ~14ms
	// at the tail, i.e. seconds of cumulative main-thread block for one tool
	// call, with the last deltas each blowing the frame budget on their own.
	// (ToolBlockShell opens the body by default while executing, so the lazy-body
	// gate that protects other blocks is open exactly when this is worst.)
	//
	// Plain `<pre>` while executing costs nothing and reads the same modulo
	// color; the highlight lands when the call leaves `executing`, still ahead of
	// the server-rendered `argumentsHtml` that replaces it after persistence.
	//
	// Note that's when the tool *returns*, not when its arguments stop growing:
	// `pushToolCall` sets `executing` before the first argument byte and only
	// `updateToolCallResult` clears it, and the SSE vocabulary has no
	// args-complete event to key off. So a slow tool (run_python pays a 2-5s
	// Pyodide cold start plus pool-queue time) shows an unhighlighted block for
	// its whole run. Highlighting at args-settled would need a new signal or a
	// debounce, and would give back some of what the gate above is buying.
	const streamingCodeHtml = $derived.by(() => {
		if (!streamingCode || status === 'executing') return null;
		if (!liveHighlighterReady.value) return null;
		const lang = resolveLiveLang(streamingCode.language);
		if (!lang) return null;
		return highlightLiveCode(streamingCode.code, lang);
	});
</script>

<ToolBlockShell {status} {attachments}>
	{#snippet summary()}
		<span class="text-[10px] font-semibold uppercase tracking-wider opacity-70">Tool</span>
		<span class="font-mono text-xs text-fg-secondary">{toolName}</span>
	{/snippet}
	{#snippet body()}
		{#if argumentsHtml}
			<!-- Server-rendered code (shiki); {@html} safe: markdown-it html=false. -->
			<!-- Shiki-highlighted code; markdown-it runs with html=false. -->
			<!-- eslint-disable-next-line svelte/no-at-html-tags -->
			<div class="gs-prose text-xs">{@html argumentsHtml}</div>
		{:else if streamingCode}
			<div>
				<div class="mb-0.5 text-[10px] font-medium uppercase tracking-wider text-fg-muted">
					{streamingCode.language}
				</div>
				{#if streamingCodeHtml}
					<!-- Shiki-highlighted code; markdown-it runs with html=false. -->
					<!-- eslint-disable-next-line svelte/no-at-html-tags -->
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
		<ToolResultSection {result} {isError} />
	{/snippet}
</ToolBlockShell>
