<!--
	Skill-activation block (activate_skill / read_skill_file). A compact chip
	(✨ Skill / 📄 Skill file) instead of the raw tool envelope; the activate body
	is the instructions rendered as markdown, read_file shows the file text, and
	errors show the clean message. The markdown render (`bodyHtml`) is read ONLY
	inside the body snippet, so the shell's collapsed state means it never runs on
	a large SKILL.md while collapsed.
-->
<script lang="ts">
	import { FileText, Sparkles } from '@lucide/svelte';
	import ToolBlockShell from './ToolBlockShell.svelte';
	import { renderLiveMarkdown } from '$lib/markdown-live';
	import type { SkillToolDisplay, ToolResultAttachment } from '$lib/chat-render';

	type Status = 'executing' | 'done' | 'error' | 'pending_approval';

	interface Props {
		/** Pre-parsed by the dispatcher (parseSkillToolDisplay), so non-null. */
		display: SkillToolDisplay;
		status: Status;
		attachments?: ToolResultAttachment[];
	}

	let { display, status, attachments }: Props = $props();

	// Read ONLY inside the body snippet below — keeps markdown-it + shiki off the
	// main thread while the block is collapsed (the shell doesn't render the body
	// snippet then, so this derived never computes).
	const bodyHtml = $derived(
		display.kind === 'activate' && !display.isError && display.body !== null
			? renderLiveMarkdown(display.body)
			: null,
	);
</script>

<ToolBlockShell {status} {attachments}>
	{#snippet summary()}
		{#if display.kind === 'activate'}
			<Sparkles size={13} strokeWidth={2.25} class="shrink-0 text-accent" aria-hidden="true" />
			<span class="text-[10px] font-semibold uppercase tracking-wider opacity-70">Skill</span>
			<span class="font-mono text-xs text-fg-secondary">{display.skillName ?? ''}</span>
		{:else}
			<FileText size={13} strokeWidth={2.25} class="shrink-0 text-accent" aria-hidden="true" />
			<span class="text-[10px] font-semibold uppercase tracking-wider opacity-70">Skill file</span>
			<span class="font-mono text-xs text-fg-secondary"
				>{display.path ?? display.skillName ?? ''}</span
			>
		{/if}
	{/snippet}
	{#snippet body()}
		{#if display.body === null}
			<div class="text-[11px] text-fg-muted">Loading…</div>
		{:else if display.isError}
			<div class="rounded border-l-2 border-danger pl-2">
				<div class="mb-0.5 text-[10px] font-medium uppercase tracking-wider text-danger">Error</div>
				<pre
					class="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] text-fg-secondary">{display.body}</pre>
			</div>
		{:else if display.kind === 'activate'}
			<!-- Instructions as markdown. {@html} safe: markdown-it html=false. -->
			<div class="gs-prose text-xs">{@html bodyHtml ?? ''}</div>
			{#if display.resources.length > 0}
				<div class="text-[10px] text-fg-muted">
					Bundled files: <span class="font-mono">{display.resources.join(', ')}</span>
				</div>
			{/if}
		{:else}
			<pre
				class="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] text-fg-secondary">{display.body}</pre>
		{/if}
	{/snippet}
</ToolBlockShell>
