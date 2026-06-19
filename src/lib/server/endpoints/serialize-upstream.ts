/**
 * Pure-ish helpers for turning our stored ChatMessage tree into the
 * `messages` array we send upstream. The image case still needs an async
 * media→dataURL resolver (so it's hard to test without mocks); the
 * tool_call / tool_result / text cases are pure and round-trip cleanly.
 *
 * Extracted so the serialization is unit-testable apart from the
 * SvelteKit request handler that drives it.
 */

import type { ChatMessage, MessagePart } from '$lib/types/api';
import type {
	ChatCompletionContentPart,
	ChatCompletionRequest,
	ChatCompletionRequestToolCall,
} from './client';

/** Resolve a stored media id to a data: URL the upstream can consume.
 *  Injected so tests don't need access to the media filesystem. */
export type MediaUrlResolver = (mediaId: string) => Promise<string>;

/** Concatenate just the text parts of a message — the cheap path when
 *  no images or tool calls are involved. */
export function partsToText(parts: MessagePart[]): string {
	return parts
		.filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text')
		.map((p) => p.text)
		.join('');
}

/**
 * A text note naming a message's non-image file attachments (PDFs, CSVs,
 * spreadsheets, …), or '' if there are none. Without this the upstream model
 * never learns a file was attached: images ride the vision content array, but
 * `file` parts have no native wire representation, so they'd otherwise be
 * dropped — and the model can't act on (or even acknowledge) a file it was
 * never told about. The filenames match how `collectConversationFiles` mounts
 * them under `/workspace/`, so the model can reference them from run_python /
 * run_skill_script (whose tool descriptions explain the mount).
 */
export function fileAttachmentNote(parts: MessagePart[]): string {
	const files = parts.filter((p): p is Extract<MessagePart, { type: 'file' }> => p.type === 'file');
	if (files.length === 0) return '';
	const names = files.map((f) => f.filename).join(', ');
	return `[Attached ${files.length === 1 ? 'file' : 'files'}: ${names}]`;
}

/** Pull the tool_call parts off an assistant message and reshape them
 *  into the OpenAI `tool_calls[]` wire format. */
function extractToolCalls(parts: MessagePart[]): ChatCompletionRequestToolCall[] {
	return parts
		.filter((p): p is Extract<MessagePart, { type: 'tool_call' }> => p.type === 'tool_call')
		.map((p) => ({
			id: p.toolCallId,
			type: 'function' as const,
			function: { name: p.toolName, arguments: p.arguments },
		}));
}

/**
 * Serialize one stored message into the upstream wire shape. Handles:
 *
 *  - `role: 'tool'` — picks the first `tool_result` part and emits
 *    `{ role:'tool', tool_call_id, content }` per OpenAI spec. Skips
 *    (returns null) when the message has no tool_result part, which
 *    shouldn't happen in practice but defensive.
 *  - `role: 'assistant'` with `tool_call` parts — emits a message with
 *    both `content` (any text parts) and `tool_calls`. `content` is
 *    null when the assistant emitted only tool calls (OpenAI accepts).
 *  - Messages with image parts — uses the vision-spec structured
 *    content array, inlining bytes as data URLs via `resolveMediaUrl`.
 *  - Everything else — bare-string content from concatenated text parts.
 */
export async function serializeMessageForUpstream(
	m: ChatMessage,
	resolveMediaUrl: MediaUrlResolver,
): Promise<ChatCompletionRequest['messages'][number] | null> {
	if (m.role === 'tool') {
		const result = m.parts.find(
			(p): p is Extract<MessagePart, { type: 'tool_result' }> => p.type === 'tool_result',
		);
		if (!result) return null;
		return {
			role: 'tool',
			content: result.result,
			tool_call_id: result.toolCallId,
		};
	}

	// A failed media branch persists as an assistant message carrying only an
	// `error` part (see MessagePart 'error'). It exists so a recovered fan-out /
	// reloaded thread can show the failure — but it has no upstream wire
	// representation, so drop it from the request rather than send an empty
	// assistant turn that would pollute the model's context.
	if (
		m.parts.some((p) => p.type === 'error') &&
		!m.parts.some((p) => p.type === 'text' || p.type === 'image' || p.type === 'tool_call')
	) {
		return null;
	}

	const toolCalls = m.role === 'assistant' ? extractToolCalls(m.parts) : [];
	const hasImages = m.parts.some((p) => p.type === 'image');
	const fileNote = fileAttachmentNote(m.parts);

	if (hasImages) {
		const content: ChatCompletionContentPart[] = [];
		for (const p of m.parts) {
			if (p.type === 'text' && p.text) {
				content.push({ type: 'text', text: p.text });
			} else if (p.type === 'image') {
				const url = await resolveMediaUrl(p.mediaId);
				content.push({ type: 'image_url', image_url: { url } });
			}
		}
		// Non-image attachments (files) get a text note so the model knows they
		// exist and can reference them by name (they're mounted in /workspace/).
		if (fileNote) content.push({ type: 'text', text: fileNote });
		const out: ChatCompletionRequest['messages'][number] = {
			role: m.role as 'system' | 'user' | 'assistant',
			content,
		};
		if (toolCalls.length > 0) out.tool_calls = toolCalls;
		return out;
	}

	const text = [partsToText(m.parts), fileNote].filter(Boolean).join('\n\n');

	if (toolCalls.length > 0) {
		// OpenAI permits null content alongside tool_calls when the
		// assistant spoke only via tools.
		return {
			role: 'assistant',
			content: text.length > 0 ? text : null,
			tool_calls: toolCalls,
		};
	}

	return {
		role: m.role as 'system' | 'user' | 'assistant',
		content: text,
	};
}

/**
 * Serialize an entire branch (root → active leaf) into the upstream
 * messages array, prepending the optional system prompt. Filters out
 * any messages that serialize to null (defensive).
 */
export async function serializeBranchForUpstream(
	branch: ChatMessage[],
	resolveMediaUrl: MediaUrlResolver,
	systemPrompt: string | null,
): Promise<ChatCompletionRequest['messages']> {
	const out: ChatCompletionRequest['messages'] = [];
	if (systemPrompt) {
		out.push({ role: 'system', content: systemPrompt });
	}
	for (const m of branch) {
		const serialized = await serializeMessageForUpstream(m, resolveMediaUrl);
		if (serialized) out.push(serialized);
	}
	return out;
}
