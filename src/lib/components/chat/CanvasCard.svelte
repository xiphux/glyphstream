<!--
	Inline canvas card. Renders in the conversation in place of the raw tool block
	whenever the assistant creates or edits a canvas — a compact, clickable
	reference to the document (title) that opens/focuses it in the pane. A
	conversation can have several canvases, so cards are deduped to one per
	artifact and `onOpen` carries the artifactId of the one to focus.
-->
<script lang="ts">
	import { FileText, CircleAlert } from '@lucide/svelte';
	import { parseCanvasAck } from '$lib/chat-render';

	interface Props {
		/** The canvas tool's result (terse ack JSON); absent while executing. */
		result?: string;
		/** Open the pane focused on this card's canvas (by artifactId). */
		onOpen?: (artifactId: string | null) => void;
	}

	let { result, onOpen }: Props = $props();

	let info = $derived(parseCanvasAck(result));
	let pending = $derived(result === undefined);
</script>

{#if info.failed}
	<!-- The edit didn't apply (e.g. str_replace didn't match). Show a quiet note
	     rather than an open affordance for a canvas that didn't change. -->
	<p class="mt-1 flex items-center gap-1.5 text-xs text-fg-muted">
		<CircleAlert size={14} class="shrink-0" />
		<span>Canvas edit didn't apply.</span>
	</p>
{:else}
	<button
		type="button"
		onclick={() => onOpen?.(info.artifactId)}
		disabled={pending}
		class="mt-1 flex w-full items-center gap-3 rounded-xl border border-border-strong bg-surface-sunken px-3 py-2.5 text-left transition hover:bg-surface-raised disabled:opacity-60"
	>
		<span
			class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/12 text-accent"
		>
			<FileText size={18} />
		</span>
		<span class="min-w-0 flex-1">
			<span class="block truncate text-sm font-medium">{info.title ?? 'Canvas'}</span>
			<!-- No version label: Phase 1 always opens the artifact's current state
			     (no per-version viewer yet), so a version number here would mislead. -->
			<span class="block text-xs text-fg-muted">
				{pending ? 'Working…' : 'Open canvas'}
			</span>
		</span>
	</button>
{/if}
