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
 *
 * That fit-check is a GUESS, on two axes — chars/4 can undercount a denser
 * tokenizer, and the advertised context window can itself be wrong (llama.cpp's
 * router reports a cold model's trained window, not its configured `--ctx-size`).
 * Either way the upstream is the one that finds out, and says so. So the whole
 * pass runs under `withOverflowRetry`: an over-window rejection re-runs it against
 * a budget corrected by the upstream's own token counts, instead of a guess we
 * can't check being terminal for the conversation.
 */

import {
	approxTokens,
	callMemoryModel,
	capAtBoundary,
	chunkStrings,
	memoryInputBudget,
	splitToBudget,
	withOverflowRetry,
} from './summarize-util';
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

/** The transcript as one entry per message with text, in order. Budgeting works on
 *  these — the same strings we actually send — rather than on the messages, whose
 *  non-text parts (tool calls/results) never reach the model here. */
function transcriptLines(messages: ChatMessage[]): string[] {
	return messages.map(messageLine).filter((l) => l.length > 0);
}

const JOIN = '\n\n';

/** The conversation rendered as a plain-text transcript for the summarizer. */
export function buildTranscript(messages: ChatMessage[]): string {
	return transcriptLines(messages).join(JOIN);
}

/** Trim + collapse whitespace + cap at a sentence/word boundary. Keeps the
 *  stored/indexed gist a single clean line even if the model returns paragraphs. */
function capSummary(s: string): string {
	return capAtBoundary(s.trim().replace(/\s+/g, ' '), SUMMARY_MAX_CHARS);
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
	const opts = {
		maxTokens: model.maxTokens,
		overheadTokens: PROMPT_OVERHEAD_TOKENS,
		minBudget: MIN_BUDGET_TOKENS,
	};
	const budget = memoryInputBudget(
		contextWindow ?? DEFAULT_CONTEXT_WINDOW,
		opts.maxTokens,
		opts.overheadTokens,
		opts.minBudget,
	);
	// Re-chunks from scratch on each retry, so an over-window rejection just costs
	// a cheaper re-do against a budget corrected by the upstream's own numbers.
	const summary = await withOverflowRetry(budget, opts, (b) =>
		summarizeMessages(model, messages, b, signal),
	);
	return capSummary(summary);
}

/** One-shot when the transcript fits the budget; otherwise map (per-chunk
 *  summaries) then reduce. Oversized single messages are pre-split so every chunk
 *  is guaranteed to fit — otherwise no budget, however small, could place them. */
async function summarizeMessages(
	model: ResolvedMemoryModel,
	messages: ChatMessage[],
	budget: number,
	signal?: AbortSignal,
): Promise<string> {
	const lines = transcriptLines(messages).flatMap((l) => splitToBudget(l, budget));
	if (approxTokens(lines.join(JOIN)) <= budget) {
		return callMemoryModel(model, SYSTEM_PROMPT, lines.join(JOIN), signal);
	}
	const partials: string[] = [];
	for (const chunk of chunkStrings(lines, budget)) {
		partials.push(await callMemoryModel(model, SYSTEM_PROMPT, chunk.join(JOIN), signal));
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
	const render = (ps: string[]) => ps.map((p, i) => `Part ${i + 1}: ${p}`).join(JOIN);
	if (approxTokens(render(partials)) <= budget) {
		return callMemoryModel(model, REDUCE_PROMPT, render(partials), signal);
	}
	// A partial is model output, so it's bounded by max_tokens rather than by our
	// budget — split any that alone overshoot, same as the transcript lines.
	const fitted = partials.flatMap((p) => splitToBudget(p, budget));
	const reduced: string[] = [];
	for (const group of chunkStrings(fitted, budget)) {
		reduced.push(await callMemoryModel(model, REDUCE_PROMPT, render(group), signal));
	}
	return reduceSummaries(model, reduced, budget, signal);
}
