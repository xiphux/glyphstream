/**
 * Explicit skill activation (the `/skill-name` composer command). Synthesizes a
 * REAL activate_skill tool exchange in the branch so an explicit activation is
 * byte-identical to a model-driven one: the same persisted assistant(tool_call)
 * + tool(result) pair, the same rendering, sticky for later turns, and
 * read_skill_file works after.
 *
 * Called from the message-send handler AFTER the user message is created and
 * BEFORE the relay generates. Because each append advances the active leaf, the
 * handler's subsequent `walkActiveBranch` already includes this exchange in the
 * upstream request. The handler then passes the returned `leafMessageId` as the
 * relay's `initialParentMessageId` so the model's response continues off the
 * tool result instead of forking off the user message.
 *
 * Server-authoritative: each name is re-validated via `getEnabledSkillByName`
 * (userId-scoped); a disabled/deleted/foreign name is skipped silently rather
 * than surfacing an error block for a stale client cache.
 */
import type { FeatureCategory, MessagePart } from '$lib/types/api';
import { generateId } from '../util/id';
import { appendMessage } from '../db/queries/messages';
import { getEnabledSkillByName } from '../db/queries/skills';
import { executeToolCalls } from '../streaming/tool-execution';

export interface SynthesizeSkillActivationsInput {
	conversationId: string;
	userId: string;
	/** The message the first synthetic activation hangs off (the user message). */
	parentMessageId: string;
	/** Skill names the user explicitly activated this turn. */
	names: string[];
	disabledFeatures: readonly FeatureCategory[];
	signal: AbortSignal;
}

/** SSE-shaped echo of one synthesized activation, so the streaming relay can
 *  replay it live (tool_call_start → executing → result) at the start of its
 *  stream — otherwise the persisted block would only surface on the turn's
 *  post-stream invalidate, popping in above the response. */
export interface SyntheticActivationEvent {
	toolCallId: string;
	toolName: string;
	/** The tool_call arguments JSON (`{"name":"…"}`). */
	arguments: string;
	/** The tool result content (the wrapped skill body). */
	result: string;
	isError: boolean;
}

export interface SynthesizeSkillActivationsResult {
	/** The final tool message id — the new active leaf / relay parent. */
	leafMessageId: string;
	/** One per synthesized activation, in branch order, for live SSE replay. */
	events: SyntheticActivationEvent[];
}

/**
 * Append `assistant(tool_call activate_skill) → tool(result)` for each enabled
 * activated skill, chaining them so the branch reads
 * `user → assistant → tool → assistant → tool → …`. Returns the final tool
 * message id (the new active leaf) to use as the relay's parent, or null when
 * nothing was synthesized (no name resolved to an enabled skill).
 */
export async function synthesizeSkillActivations(
	input: SynthesizeSkillActivationsInput,
): Promise<SynthesizeSkillActivationsResult | null> {
	let parentId = input.parentMessageId;
	let synthesizedAny = false;
	const seen = new Set<string>();
	const events: SyntheticActivationEvent[] = [];

	for (const rawName of input.names) {
		const name = typeof rawName === 'string' ? rawName.trim() : '';
		if (!name || seen.has(name)) continue;
		seen.add(name);

		const ref = getEnabledSkillByName(input.userId, name);
		if (!ref) continue; // disabled / deleted / foreign — skip silently.

		const toolCallId = generateId();
		const args = JSON.stringify({ name });
		const toolCallPart: Extract<MessagePart, { type: 'tool_call' }> = {
			type: 'tool_call',
			toolCallId,
			toolName: 'activate_skill',
			arguments: args,
		};
		const assistantMsg = appendMessage({
			conversationId: input.conversationId,
			parentMessageId: parentId,
			role: 'assistant',
			parts: [toolCallPart],
			finishReason: 'tool_calls',
		});

		// Reuse the real execution path so the tool result is identical to
		// model-driven activation (activate_skill is built-in → runs inline, no
		// approval). The emit is a no-op here: there's no SSE stream yet
		// (pre-relay). We return the result so the relay can replay these as live
		// SSE events at the start of its stream.
		const { toolMessages } = await executeToolCalls({
			assistantMessage: assistantMsg,
			conversationId: input.conversationId,
			userId: input.userId,
			signal: input.signal,
			disabledFeatures: input.disabledFeatures,
			emit: () => {},
		});

		// One tool_call → one tool message; advance the chain to it. Fall back to
		// the assistant message if (unexpectedly) no tool message was persisted.
		const toolMsg = toolMessages.at(-1);
		const resultPart = toolMsg?.parts.find(
			(p): p is Extract<MessagePart, { type: 'tool_result' }> => p.type === 'tool_result',
		);
		events.push({
			toolCallId,
			toolName: 'activate_skill',
			arguments: args,
			result: resultPart?.result ?? '',
			isError: resultPart?.isError ?? false,
		});
		parentId = toolMsg?.id ?? assistantMsg.id;
		synthesizedAny = true;
	}

	return synthesizedAny ? { leafMessageId: parentId, events } : null;
}
