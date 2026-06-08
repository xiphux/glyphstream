<!--
	Tool-call display dispatcher. Picks the per-kind renderer by tool name (the
	only client-side signal) and forwards the block's props:
	  - activate_skill / read_skill_file → SkillToolBlock (chip + instructions)
	  - tools whose primary arg is source code (CODE_ARG_TOOLS, e.g. run_python)
	    → CodeArgToolBlock (highlighted code)
	  - everything else → GenericToolBlock (JSON args/result + MCP approval prompt)

	The shared <details> chrome, collapse/open-state, status badge, lazy body, and
	generated-media attachments live in ToolBlockShell (rendered by each kind).
	Adding a new special case = one new component + one branch here.
-->
<script lang="ts">
	import SkillToolBlock from '$lib/components/chat/tool-blocks/SkillToolBlock.svelte';
	import CodeArgToolBlock from '$lib/components/chat/tool-blocks/CodeArgToolBlock.svelte';
	import GenericToolBlock from '$lib/components/chat/tool-blocks/GenericToolBlock.svelte';
	import {
		isCodeArgTool,
		parseSkillToolDisplay,
		type ToolResultAttachment,
	} from '$lib/chat-render';
	import type { ApprovalAction } from '$lib/approval-workflow';

	type Status = 'executing' | 'done' | 'error' | 'pending_approval';

	interface Props {
		toolName: string;
		argumentsJson: string;
		/** Pre-rendered code HTML (server shiki) for run_python; CodeArgToolBlock. */
		argumentsHtml?: string;
		/** undefined while the tool is still executing. */
		result?: string;
		isError?: boolean;
		status: Status;
		/** pending_approval only — identifies which pending row a decision updates. */
		toolCallId?: string;
		/** Staged approval decision for this call (highlights the chosen button). */
		decision?: ApprovalAction | null;
		approvalBusy?: boolean;
		onApprovalSelect?: (toolCallId: string, action: ApprovalAction) => void;
		/** Media the tool produced — shown attached to this block. */
		attachments?: ToolResultAttachment[];
	}

	let {
		toolName,
		argumentsJson,
		argumentsHtml,
		result,
		isError,
		status,
		toolCallId,
		decision = null,
		approvalBusy = false,
		onApprovalSelect,
		attachments,
	}: Props = $props();

	// Cheap (regex/name-check, memoized) — NOT the expensive markdown render,
	// which stays deferred inside SkillToolBlock's body snippet. Returns null for
	// non-skill tools.
	const skill = $derived(parseSkillToolDisplay(toolName, argumentsJson, result, isError ?? false));
</script>

{#if skill}
	<SkillToolBlock display={skill} {status} {attachments} />
{:else if isCodeArgTool(toolName)}
	<CodeArgToolBlock
		{toolName}
		{argumentsJson}
		{argumentsHtml}
		{result}
		{isError}
		{status}
		{attachments}
	/>
{:else}
	<GenericToolBlock
		{toolName}
		{argumentsJson}
		{result}
		{isError}
		{status}
		{attachments}
		{toolCallId}
		{decision}
		{approvalBusy}
		{onApprovalSelect}
	/>
{/if}
