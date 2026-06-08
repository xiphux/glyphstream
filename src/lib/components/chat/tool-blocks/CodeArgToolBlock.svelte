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
	// Upgrade mid-stream code to client-side shiki the moment the lazy chunk
	// lands (reading liveHighlighterReady.value re-runs this on load).
	const streamingCodeHtml = $derived.by(() => {
		if (!streamingCode) return null;
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
			<div class="gs-prose text-xs">{@html argumentsHtml}</div>
		{:else if streamingCode}
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
		<ToolResultSection {result} {isError} />
	{/snippet}
</ToolBlockShell>
