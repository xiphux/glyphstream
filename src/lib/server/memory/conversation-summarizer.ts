/**
 * The LLM step of the per-conversation summary pass: turn a conversation's
 * message branch into a short, denoised gist for search. Runs on the
 * `[memory_model]` (same tier as dreaming). Applying/persisting is the worker's
 * job (`conversation-summary.ts`); this module is transcript + prompt + call +
 * map-reduce only.
 *
 * The load-bearing case: a conversation can be longer than the memory model's
 * context window (it may have been held on a longer-context chat model). So we
 * budget-check the transcript (char/4 heuristic — model-agnostic, matching
 * compaction's own estimate; NOT the chat model's reported usage) and, when it
 * overflows, hierarchically map-reduce: summarize windows that fit, then reduce
 * the partials (recursively if the partials themselves overflow). The memory
 * model's window therefore never limits what we can summarize.
 */

import { chatCompletionSync } from '../endpoints/client';
import { acquireEndpointSlot } from '../endpoints/concurrency';
import { estimateContentTokens } from '$lib/chat-compaction';
import type { ResolvedMemoryModel } from '../tasks/memory-model';
import type { ChatMessage } from '$lib/types/api';

/** Max stored/indexed summary length. A gist, not a transcript. */
export const SUMMARY_MAX_CHARS = 600;

/** Reserve (tokens) for the system prompt + a safety margin, so the fit-check
 *  doesn't ride the exact edge of the model's window. */
const PROMPT_OVERHEAD_TOKENS = 400;
/** Assumed window when the memory model's context size can't be resolved. */
const DEFAULT_CONTEXT_WINDOW = 8000;
/** Floor so a tiny/misconfigured window can't drive the budget to zero. */
const MIN_BUDGET_TOKENS = 1000;

const SYSTEM_PROMPT =
	'You are summarizing a conversation between a user and an assistant so it can be found later by search. Write a short, standalone descriptive note — third person, about WHAT WAS DISCUSSED: the topics, questions, and any decisions, conclusions, or outcomes. Do not address the user, do not reply to the conversation, and do not comment on the act of summarizing. Two or three sentences of plain prose.';

const REDUCE_PROMPT =
	'You are combining several partial summaries of ONE conversation (given in order) into a single short summary. Preserve the distinct topics and any decisions or outcomes; drop redundancy. Same rules: third person, describes what was discussed, two or three sentences of plain prose, no commentary.';

/** `role: <joined text parts>` for one message; '' if it has no text (image-only
 *  / tool-only turn) so it drops out of the transcript. */
function messageLine(m: ChatMessage): string {
	const text = m.parts
		.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
		.map((p) => p.text)
		.join('\n')
		.trim();
	return text ? `${m.role}: ${text}` : '';
}

/** The conversation rendered as a plain-text transcript for the summarizer. */
export function buildTranscript(messages: ChatMessage[]): string {
	return messages
		.map(messageLine)
		.filter((l) => l.length > 0)
		.join('\n\n');
}

/** Trim + collapse whitespace + hard-cap. Keeps the stored/indexed gist a single
 *  clean line even if the model returns paragraphs. */
function capSummary(s: string): string {
	const clean = s.trim().replace(/\s+/g, ' ');
	return clean.length <= SUMMARY_MAX_CHARS
		? clean
		: clean.slice(0, SUMMARY_MAX_CHARS - 1).trimEnd() + '…';
}

/** char/4, matching `estimateContentTokens`, for budgeting plain strings. */
function approxTokens(s: string): number {
	return Math.ceil(s.length / 4);
}

/**
 * Summarize a conversation branch into a capped gist. Returns '' if the model
 * yields nothing (the worker then skips the write and retries next sweep).
 * `contextWindow` null → a conservative default; the budget is what a single
 * call may carry before we map-reduce.
 */
export async function summarizeConversation(
	model: ResolvedMemoryModel,
	messages: ChatMessage[],
	contextWindow: number | null,
	signal?: AbortSignal,
): Promise<string> {
	const budget = Math.max(
		(contextWindow ?? DEFAULT_CONTEXT_WINDOW) - model.maxTokens - PROMPT_OVERHEAD_TOKENS,
		MIN_BUDGET_TOKENS,
	);
	return capSummary(await summarizeMessages(model, messages, budget, signal));
}

/** One-shot when the transcript fits the budget; otherwise map (per-chunk
 *  summaries) then reduce. */
async function summarizeMessages(
	model: ResolvedMemoryModel,
	messages: ChatMessage[],
	budget: number,
	signal?: AbortSignal,
): Promise<string> {
	if (estimateContentTokens(messages) <= budget) {
		return callModel(model, SYSTEM_PROMPT, buildTranscript(messages), signal);
	}
	const partials: string[] = [];
	for (const chunk of chunkMessages(messages, budget)) {
		partials.push(await callModel(model, SYSTEM_PROMPT, buildTranscript(chunk), signal));
	}
	return reduceSummaries(model, partials, budget, signal);
}

/** Fold partial summaries into one. Recurses if the partials themselves overflow
 *  the budget (many chunks → reduce in groups, then reduce those). */
async function reduceSummaries(
	model: ResolvedMemoryModel,
	partials: string[],
	budget: number,
	signal?: AbortSignal,
): Promise<string> {
	if (partials.length <= 1) return partials[0] ?? '';
	const render = (ps: string[]) => ps.map((p, i) => `Part ${i + 1}: ${p}`).join('\n\n');
	if (approxTokens(render(partials)) <= budget) {
		return callModel(model, REDUCE_PROMPT, render(partials), signal);
	}
	const reduced: string[] = [];
	for (const group of chunkStrings(partials, budget)) {
		reduced.push(await callModel(model, REDUCE_PROMPT, render(group), signal));
	}
	return reduceSummaries(model, reduced, budget, signal);
}

/** Greedily group messages so each group's estimated tokens stay within budget.
 *  A single over-budget message becomes its own group (can't split at message
 *  granularity — a rare edge the model will truncate). */
function chunkMessages(messages: ChatMessage[], budget: number): ChatMessage[][] {
	const groups: ChatMessage[][] = [];
	let cur: ChatMessage[] = [];
	for (const m of messages) {
		const t = estimateContentTokens([m]);
		if (cur.length > 0 && estimateContentTokens(cur) + t > budget) {
			groups.push(cur);
			cur = [];
		}
		cur.push(m);
	}
	if (cur.length > 0) groups.push(cur);
	return groups;
}

/** Same greedy grouping for the reduce step's partial-summary strings. */
function chunkStrings(items: string[], budget: number): string[][] {
	const groups: string[][] = [];
	let cur: string[] = [];
	let curTokens = 0;
	for (const s of items) {
		const t = approxTokens(s);
		if (cur.length > 0 && curTokens + t > budget) {
			groups.push(cur);
			cur = [];
			curTokens = 0;
		}
		cur.push(s);
		curTokens += t;
	}
	if (cur.length > 0) groups.push(cur);
	return groups;
}

async function callModel(
	model: ResolvedMemoryModel,
	systemPrompt: string,
	userContent: string,
	signal?: AbortSignal,
): Promise<string> {
	// Queue each call on the shared per-endpoint slot (release even on error). A
	// map-reduce makes several calls, so slotting PER CALL rather than around the
	// whole summarization lets a waiting live chat slip in between chunks — a dream
	// or a summary is a fair peer, never a preempting or endpoint-hogging one.
	const slot = await acquireEndpointSlot(model.endpoint.id, model.endpoint.maxConcurrent, {
		signal,
	});
	try {
		const resp = await chatCompletionSync(
			model.endpoint,
			{
				model: model.upstreamId,
				messages: [
					{ role: 'system', content: systemPrompt },
					{ role: 'user', content: userContent },
				],
				max_tokens: model.maxTokens,
				temperature: model.temperature,
			},
			signal,
		);
		return (resp.choices?.[0]?.message?.content ?? '').trim();
	} finally {
		slot.release();
	}
}
