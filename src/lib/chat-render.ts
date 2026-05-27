/**
 * Pure rendering logic for chat bubbles. Both the persisted message view
 * and the in-flight streaming view convert their state into the same
 * RenderBlock[] shape; the chat page's `renderBlocks` snippet draws them
 * identically. Keeping this logic out of the Svelte component lets us
 * pin the contract in vitest — chat rendering is core enough that a
 * silent regression here breaks every conversation.
 */

import type { ChatMessage, MessagePart } from './types/api';

// --- block shape --------------------------------------------------------
//
// One element of the per-bubble render. The snippet branches on `type`
// and draws each block — no logic lives in the markup. New content
// types (web_search outputs, MCP results, memory recalls…) land here as
// a new union variant and both render paths get them for free.

export type RenderBlock =
	| { type: 'reasoning'; text: string }
	/** Pre-rendered markdown HTML — server-side shiki for persisted
	 *  assistant rows, client-side markdown-it for live streaming.
	 *  Both pass through markdown-it with html=false so {@html} is safe. */
	| { type: 'html'; html: string }
	/** Plain-text fallback for messages without rendered HTML (user
	 *  rows, just-arrived in-flight text whose rAF render hasn't fired). */
	| { type: 'plain-text'; text: string }
	| {
			type: 'tool_call';
			toolCallId: string;
			toolName: string;
			arguments: string;
			result?: string;
			isError?: boolean;
			status: 'executing' | 'done' | 'error';
	  }
	| { type: 'image'; mediaId: string; alt?: string }
	| { type: 'video'; mediaId: string };

// --- in-flight segments -------------------------------------------------
//
// The live streaming state for the in-flight bubble is a single ordered
// list of segments — text and tool_call interleaved in arrival order.
// This is what makes multi-tool-per-turn render correctly: text₀ →
// tool_a → text₁ → tool_b → text₂ produces 5 segments; the renderer
// just walks them in order.

export interface InFlightTextSegment {
	kind: 'text';
	text: string;
	/** Cached rendered HTML — populated by the page's rAF effect. Empty
	 *  string means "render plain-text fallback while waiting." */
	html: string;
}

export interface InFlightToolCallSegment {
	kind: 'tool_call';
	toolCallId: string;
	toolName: string;
	arguments: string;
	status: 'executing' | 'done' | 'error';
	result?: string;
	isError?: boolean;
}

export type InFlightSegment = InFlightTextSegment | InFlightToolCallSegment;

// --- in-flight segment transformations ---------------------------------
//
// Pure (current segments, event) → new segments. The chat page calls
// these on each SSE event and assigns the result back to the $state. By
// keeping the transformations pure we can vitest the state machine
// without spinning up a Svelte component or mocking $state.

/** Append a text chunk. Grows the trailing text segment when one exists,
 *  otherwise opens a new segment (which happens after every tool_call). */
export function appendText(segments: InFlightSegment[], chunk: string): InFlightSegment[] {
	if (segments.length === 0) {
		return [{ kind: 'text', text: chunk, html: '' }];
	}
	const last = segments[segments.length - 1];
	if (last.kind === 'text') {
		return [
			...segments.slice(0, -1),
			{ kind: 'text', text: last.text + chunk, html: last.html }
		];
	}
	return [...segments, { kind: 'text', text: chunk, html: '' }];
}

/** Push a new tool_call segment in 'executing' state. Subsequent
 *  updateToolCallArgs/updateToolCallResult calls find it by id. */
export function pushToolCall(
	segments: InFlightSegment[],
	toolCallId: string,
	toolName: string
): InFlightSegment[] {
	return [
		...segments,
		{ kind: 'tool_call', toolCallId, toolName, arguments: '', status: 'executing' }
	];
}

/** Append a chunk to a tool_call's `arguments` string, identified by
 *  toolCallId. No-ops when the id isn't found (defensive against an
 *  args_delta arriving before its own start event, which would be a
 *  spec-violating upstream but we don't crash). */
export function updateToolCallArgs(
	segments: InFlightSegment[],
	toolCallId: string,
	argsDelta: string
): InFlightSegment[] {
	const idx = segments.findIndex(
		(s) => s.kind === 'tool_call' && s.toolCallId === toolCallId
	);
	if (idx < 0) return segments;
	const seg = segments[idx];
	if (seg.kind !== 'tool_call') return segments;
	return [
		...segments.slice(0, idx),
		{ ...seg, arguments: seg.arguments + argsDelta },
		...segments.slice(idx + 1)
	];
}

/** Mark a tool_call as finished — flips status to 'done' or 'error' and
 *  records the result. */
export function updateToolCallResult(
	segments: InFlightSegment[],
	toolCallId: string,
	result: string,
	isError: boolean
): InFlightSegment[] {
	const idx = segments.findIndex(
		(s) => s.kind === 'tool_call' && s.toolCallId === toolCallId
	);
	if (idx < 0) return segments;
	const seg = segments[idx];
	if (seg.kind !== 'tool_call') return segments;
	return [
		...segments.slice(0, idx),
		{ ...seg, status: isError ? 'error' : 'done', result, isError },
		...segments.slice(idx + 1)
	];
}

// --- conversion: messages / segments → render blocks --------------------

/** Convert a persisted ChatMessage into RenderBlock[] for the unified
 *  renderer. tool_call parts get their status from `toolResults` — when
 *  a matching tool_result exists in the side-map, status is 'done' (or
 *  'error' if isError); otherwise it's 'executing' (still in-flight). */
export function messageToBlocks(
	m: ChatMessage,
	toolResults: Map<string, { result: string; isError: boolean }>
): RenderBlock[] {
	const blocks: RenderBlock[] = [];
	if (m.reasoningText) blocks.push({ type: 'reasoning', text: m.reasoningText });

	// Use the server-rendered contentHtml at the position of the FIRST
	// text part. This preserves shiki's code-block formatting which we
	// can't reproduce client-side (shiki stays server-only by bundle).
	let usedContentHtml = false;
	for (const p of m.parts) {
		const block = partToBlock(p, m, toolResults, usedContentHtml);
		if (!block) continue;
		if (block.type === 'html' && p.type === 'text') usedContentHtml = true;
		blocks.push(block);
	}
	return blocks;
}

function partToBlock(
	p: MessagePart,
	m: ChatMessage,
	toolResults: Map<string, { result: string; isError: boolean }>,
	usedContentHtml: boolean
): RenderBlock | null {
	switch (p.type) {
		case 'text':
			if (!p.text) return null;
			if (!usedContentHtml && m.role === 'assistant' && m.contentHtml) {
				return { type: 'html', html: m.contentHtml };
			}
			return { type: 'plain-text', text: p.text };
		case 'tool_call': {
			const status = toolResults.get(p.toolCallId);
			return {
				type: 'tool_call',
				toolCallId: p.toolCallId,
				toolName: p.toolName,
				arguments: p.arguments,
				result: status?.result,
				isError: status?.isError,
				status: status ? (status.isError ? 'error' : 'done') : 'executing'
			};
		}
		case 'image':
			return { type: 'image', mediaId: p.mediaId, alt: p.alt };
		case 'video':
			return { type: 'video', mediaId: p.mediaId };
		case 'reasoning':
			// reasoning parts (future): folded into the message-level
			// reasoning block at the top, not re-rendered inline
			return null;
		case 'tool_result':
			// tool_result parts live on role:'tool' messages — folded into
			// matching tool_call blocks via the toolResults map
			return null;
	}
}

/** Convert in-flight streaming state into RenderBlock[]. Reasoning
 *  always renders first; segments render in arrival order. */
export function inFlightToBlocks(
	segments: InFlightSegment[],
	reasoning: string
): RenderBlock[] {
	const blocks: RenderBlock[] = [];
	if (reasoning) blocks.push({ type: 'reasoning', text: reasoning });
	for (const seg of segments) {
		if (seg.kind === 'text') {
			if (seg.html) blocks.push({ type: 'html', html: seg.html });
			else if (seg.text) blocks.push({ type: 'plain-text', text: seg.text });
		} else {
			blocks.push({
				type: 'tool_call',
				toolCallId: seg.toolCallId,
				toolName: seg.toolName,
				arguments: seg.arguments,
				result: seg.result,
				isError: seg.isError,
				status: seg.status
			});
		}
	}
	return blocks;
}

// --- visibility / tool-result indexing ----------------------------------

/** Strip role:'tool' messages from the visible list. Their results are
 *  folded into the assistant message that emitted the matching
 *  tool_call (see `buildToolResultsMap` for the lookup). */
export function filterVisibleMessages(messages: ChatMessage[]): ChatMessage[] {
	return messages.filter((m) => m.role !== 'tool');
}

/** Build the `toolCallId → result` lookup that messageToBlocks uses to
 *  resolve tool_call statuses. */
export function buildToolResultsMap(
	messages: ChatMessage[]
): Map<string, { result: string; isError: boolean }> {
	const out = new Map<string, { result: string; isError: boolean }>();
	for (const msg of messages) {
		if (msg.role !== 'tool') continue;
		for (const p of msg.parts) {
			if (p.type === 'tool_result') {
				out.set(p.toolCallId, { result: p.result, isError: p.isError === true });
			}
		}
	}
	return out;
}

// --- bubble-merge flags -------------------------------------------------

/** Compute whether the message at `index` in `visibleMessages` should
 *  visually merge with the previous or next message (so a multi-iteration
 *  tool turn's separate assistant rows render as one continuous bubble).
 *
 *  Merges happen only between consecutive `role:'assistant'` rows.
 *  Editing breaks the merge — the inline-edit replaces the article
 *  entirely, so we don't want it visually fused with its neighbors. */
export function computeMergeFlags(
	visibleMessages: ChatMessage[],
	index: number,
	editingMessageId: string | null
): { mergeWithPrev: boolean; mergeWithNext: boolean } {
	const m = visibleMessages[index];
	if (!m || m.role !== 'assistant' || m.id === editingMessageId) {
		return { mergeWithPrev: false, mergeWithNext: false };
	}
	const prev = index > 0 ? visibleMessages[index - 1] : null;
	const next = index < visibleMessages.length - 1 ? visibleMessages[index + 1] : null;
	return {
		mergeWithPrev:
			!!prev && prev.role === 'assistant' && prev.id !== editingMessageId,
		mergeWithNext:
			!!next && next.role === 'assistant' && next.id !== editingMessageId
	};
}
