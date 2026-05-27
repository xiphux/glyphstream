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

	type Status = 'executing' | 'done' | 'error';

	interface Props {
		toolName: string;
		argumentsJson: string;
		/** undefined while the tool is still executing. */
		result?: string;
		isError?: boolean;
		status: Status;
		/** Optional slot for callers that want to add a status suffix
		 *  (elapsed time, etc.). Renders inside the badge. */
		badgeSuffix?: Snippet;
	}

	let { toolName, argumentsJson, result, isError, status, badgeSuffix }: Props = $props();

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

	// Collapsed by default when the call is done — tool details are
	// metadata for the curious, not primary content. Auto-expanded
	// while executing so the user sees activity. Errors stay expanded
	// because the user typically WANTS to see what went wrong.
	const openByDefault = $derived(status === 'executing' || status === 'error');

	const badgeColorClass = $derived(
		status === 'executing'
			? 'text-amber-700 dark:text-amber-400'
			: status === 'error'
				? 'text-red-700 dark:text-red-400'
				: 'text-emerald-700 dark:text-emerald-400'
	);
</script>

<details
	open={openByDefault}
	class="mt-2 rounded-md border border-neutral-300 bg-white text-xs dark:border-neutral-700 dark:bg-neutral-900"
>
	<summary
		class="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-neutral-500 select-none"
	>
		<span class="text-[10px] font-semibold uppercase tracking-wider opacity-70">Tool</span>
		<span class="font-mono text-xs text-neutral-700 dark:text-neutral-300">{toolName}</span>
		<span class="flex-1"></span>
		<span class="text-[10px] font-medium uppercase tracking-wide {badgeColorClass}">
			{#if status === 'executing'}
				running
			{:else if status === 'error'}
				error
			{:else}
				done
			{/if}
			{#if badgeSuffix}<span class="opacity-70 normal-case">{@render badgeSuffix()}</span>{/if}
		</span>
	</summary>
	<div class="space-y-2 border-t border-neutral-200 p-2 dark:border-neutral-800">
		{#if prettyArgs}
			<div>
				<div class="mb-0.5 text-[10px] font-medium uppercase tracking-wider text-neutral-500">
					Arguments
				</div>
				<pre class="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] text-neutral-700 dark:text-neutral-300">{prettyArgs}</pre>
			</div>
		{/if}
		{#if result !== undefined}
			<div
				class="rounded {isError
					? 'border-l-2 border-red-400 pl-2 dark:border-red-500'
					: ''}"
			>
				<div class="mb-0.5 text-[10px] font-medium uppercase tracking-wider {isError ? 'text-red-600 dark:text-red-400' : 'text-neutral-500'}">
					{isError ? 'Error' : 'Result'}
				</div>
				<pre class="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] text-neutral-700 dark:text-neutral-300">{prettyResult}</pre>
			</div>
		{/if}
	</div>
</details>
