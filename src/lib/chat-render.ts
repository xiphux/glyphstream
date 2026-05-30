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
	/** `open` means the `<details>` element should render expanded —
	 *  in-flight reasoning starts expanded (so the user watches the
	 *  model think); persisted reasoning starts collapsed (the user
	 *  already saw it while it streamed; now it's metadata). */
	| { type: 'reasoning'; text: string; open: boolean }
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
			status: 'executing' | 'done' | 'error' | 'pending_approval';
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
	status: 'executing' | 'done' | 'error' | 'pending_approval';
	result?: string;
	isError?: boolean;
}

export interface InFlightReasoningSegment {
	kind: 'reasoning';
	text: string;
}

export type InFlightSegment =
	| InFlightTextSegment
	| InFlightToolCallSegment
	| InFlightReasoningSegment;

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

/** Append a reasoning chunk. Same grow-or-open pattern as appendText —
 *  consecutive reasoning chunks coalesce into one segment, but if a
 *  text or tool_call lands in between (the model interleaved), a new
 *  reasoning segment opens for the next batch. This is what lets the
 *  in-flight bubble render reasoning at its chronological position
 *  rather than always at the top. */
export function appendReasoning(
	segments: InFlightSegment[],
	chunk: string
): InFlightSegment[] {
	if (segments.length === 0) {
		return [{ kind: 'reasoning', text: chunk }];
	}
	const last = segments[segments.length - 1];
	if (last.kind === 'reasoning') {
		return [...segments.slice(0, -1), { kind: 'reasoning', text: last.text + chunk }];
	}
	return [...segments, { kind: 'reasoning', text: chunk }];
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

/** Flip a tool_call segment to `pending_approval` so the in-flight bubble
 *  renders the Allow / Allow Always / Reject buttons the instant the
 *  server-side decision lands — instead of waiting for the post-stream
 *  invalidate to surface the persisted status. */
export function markToolCallPendingApproval(
	segments: InFlightSegment[],
	toolCallId: string,
	toolName: string,
	args: string
): InFlightSegment[] {
	const idx = segments.findIndex(
		(s) => s.kind === 'tool_call' && s.toolCallId === toolCallId
	);
	if (idx < 0) {
		// Defensive — server emitted pending_approval for a tool_call we
		// never saw a `tool_call_start` for. Synthesize the segment so
		// the UI doesn't drop the approval prompt entirely.
		return [
			...segments,
			{
				kind: 'tool_call',
				toolCallId,
				toolName,
				arguments: args,
				status: 'pending_approval'
			}
		];
	}
	const seg = segments[idx];
	if (seg.kind !== 'tool_call') return segments;
	return [
		...segments.slice(0, idx),
		{ ...seg, status: 'pending_approval', arguments: args || seg.arguments },
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
	toolResults: Map<string, ToolResultEntry>
): RenderBlock[] {
	const blocks: RenderBlock[] = [];
	if (m.reasoningText) blocks.push({ type: 'reasoning', text: m.reasoningText, open: false });

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
	toolResults: Map<string, ToolResultEntry>,
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
			const entry = toolResults.get(p.toolCallId);
			let status: 'executing' | 'done' | 'error' | 'pending_approval';
			if (!entry) status = 'executing';
			else if (entry.status === 'pending_approval') status = 'pending_approval';
			else status = entry.isError ? 'error' : 'done';
			return {
				type: 'tool_call',
				toolCallId: p.toolCallId,
				toolName: p.toolName,
				arguments: p.arguments,
				result: entry?.result,
				isError: entry?.isError,
				status
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

/** Convert in-flight streaming state into RenderBlock[]. Segments
 *  render in arrival order — reasoning, text, and tool_calls all
 *  interleave at whatever position they streamed in at. This is what
 *  matches the user's mental model: "things should appear in the
 *  order they happened, not get reordered after the fact." */
export function inFlightToBlocks(segments: InFlightSegment[]): RenderBlock[] {
	const blocks: RenderBlock[] = [];
	for (const seg of segments) {
		switch (seg.kind) {
			case 'reasoning':
				// open: true for live reasoning — the user is actively
				// watching the model think. The persisted side (after
				// invalidate) shows the same content collapsed.
				blocks.push({ type: 'reasoning', text: seg.text, open: true });
				break;
			case 'text':
				if (seg.html) blocks.push({ type: 'html', html: seg.html });
				else if (seg.text) blocks.push({ type: 'plain-text', text: seg.text });
				break;
			case 'tool_call':
				blocks.push({
					type: 'tool_call',
					toolCallId: seg.toolCallId,
					toolName: seg.toolName,
					arguments: seg.arguments,
					result: seg.result,
					isError: seg.isError,
					status: seg.status
				});
				break;
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

export interface ToolResultEntry {
	result: string;
	isError: boolean;
	status?: 'pending_approval';
}

/** Build the `toolCallId → result` lookup that messageToBlocks uses to
 *  resolve tool_call statuses. Carries the pending_approval status
 *  through so the inline tool block can render the Allow / Always /
 *  Reject prompt right where its tool_call appears. */
export function buildToolResultsMap(
	messages: ChatMessage[]
): Map<string, ToolResultEntry> {
	const out = new Map<string, ToolResultEntry>();
	for (const msg of messages) {
		if (msg.role !== 'tool') continue;
		for (const p of msg.parts) {
			if (p.type !== 'tool_result') continue;
			const entry: ToolResultEntry = {
				result: p.result,
				isError: p.isError === true
			};
			if (p.status === 'pending_approval') entry.status = 'pending_approval';
			out.set(p.toolCallId, entry);
		}
	}
	return out;
}

export interface PendingApprovalInfo {
	toolCallId: string;
	toolName: string;
	displayLabel?: string;
	category?: string;
	args: string;
}

/**
 * Find every persisted tool_result row on the visible branch with
 * `status: 'pending_approval'` and pair it with the original tool_call
 * (toolName + arguments) from the assistant message that emitted it.
 * Returned in branch order so the UI renders prompts in the same
 * sequence the model proposed them.
 *
 * Returns [] in the steady state — the cards only appear when the model
 * tried to use an MCP tool the user hasn't trusted yet AND the relay
 * halted so the user could decide.
 */
export function buildPendingApprovals(messages: ChatMessage[]): PendingApprovalInfo[] {
	const callIndex = new Map<
		string,
		{ toolName: string; args: string }
	>();
	for (const msg of messages) {
		if (msg.role !== 'assistant') continue;
		for (const p of msg.parts) {
			if (p.type === 'tool_call') {
				callIndex.set(p.toolCallId, { toolName: p.toolName, args: p.arguments });
			}
		}
	}
	const out: PendingApprovalInfo[] = [];
	for (const msg of messages) {
		if (msg.role !== 'tool') continue;
		for (const p of msg.parts) {
			if (p.type !== 'tool_result') continue;
			if (p.status !== 'pending_approval') continue;
			const call = callIndex.get(p.toolCallId);
			if (!call) continue;
			out.push({
				toolCallId: p.toolCallId,
				toolName: call.toolName,
				args: call.args
			});
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
 *  entirely, so we don't want it visually fused with its neighbors.
 *
 *  `mergeIntoInFlight` is true when the in-flight bubble is open and the
 *  message at `index` is the trailing assistant message — the live
 *  bubble is then conceptually a continuation of that row (the
 *  approval-resume case, where the prior turn halted on a tool call and
 *  the resumed turn streams in the next iteration's text). Forcing
 *  `mergeWithNext` here keeps the bottom rounded corner off so the
 *  live bubble visually fuses with the prior one, matching how the
 *  persisted view will look after invalidate. Avoids the "snap from
 *  two bubbles to one" jolt when the stream completes. */
export function computeMergeFlags(
	visibleMessages: ChatMessage[],
	index: number,
	editingMessageId: string | null,
	mergeIntoInFlight = false
): { mergeWithPrev: boolean; mergeWithNext: boolean } {
	const m = visibleMessages[index];
	if (!m || m.role !== 'assistant' || m.id === editingMessageId) {
		return { mergeWithPrev: false, mergeWithNext: false };
	}
	const prev = index > 0 ? visibleMessages[index - 1] : null;
	const next = index < visibleMessages.length - 1 ? visibleMessages[index + 1] : null;
	const isLastVisible = index === visibleMessages.length - 1;
	return {
		mergeWithPrev:
			!!prev && prev.role === 'assistant' && prev.id !== editingMessageId,
		mergeWithNext:
			(!!next && next.role === 'assistant' && next.id !== editingMessageId) ||
			(mergeIntoInFlight && isLastVisible)
	};
}
