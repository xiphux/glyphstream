<!--
	Shared Result / Error section for tool blocks (generic + code-arg tools).
	An empty-string result still renders (a result *exists*); only `undefined`
	(still executing) omits it.
-->
<script lang="ts">
	import { prettyJson } from '$lib/chat-render';

	interface Props {
		result?: string;
		isError?: boolean;
	}

	let { result, isError }: Props = $props();

	const prettyResult = $derived(prettyJson(result));
</script>

{#if result !== undefined}
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
