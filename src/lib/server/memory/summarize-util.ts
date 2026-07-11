/**
 * Shared plumbing for the memory model's background text passes (per-conversation
 * summaries and the orientation overview): a slot-queued single call, a token
 * estimate, and greedy string batching. Kept in one place so the summarizer and
 * the overview builder can't drift on how they call the model or budget input.
 */

import { chatCompletionSync, parseContextOverflow } from '../endpoints/client';
import { acquireEndpointSlot } from '../endpoints/concurrency';
import type { ResolvedMemoryModel } from '../tasks/memory-model';

/** char/4 — the same model-agnostic heuristic `estimateContentTokens` uses, for
 *  budgeting plain strings. */
export function approxTokens(s: string): number {
	return Math.ceil(s.length / 4);
}

/**
 * Fraction of a model's context window the background memory passes trust as
 * usable INPUT space, held back on top of the `maxTokens` + prompt-overhead
 * subtraction. The token counts feeding these budgets are the model-agnostic
 * `chars/4` heuristic (`approxTokens` / `estimateContentTokens`); a denser
 * tokenizer (Gemma, CJK, code) can undercount, so a request the estimate calls
 * "fits" can still overflow the upstream's real `n_ctx`. Reserving this slice
 * keeps an under-estimate inside the true window, so map-reduce chunks land
 * comfortably under it instead of on its edge. It does NOT touch live-chat
 * compaction — that path uses the raw reported window on purpose (it wants every
 * usable token; a mis-estimate there degrades to a recoverable overflow, not a
 * silently-wedged background worker).
 */
export const MEMORY_BUDGET_SAFETY_FRACTION = 0.85;

/**
 * Usable input budget for one memory-model call: the safety-fraction of the
 * context window, less the completion reserve (`maxTokens`) and prompt overhead,
 * floored at `minBudget` so a tiny/misconfigured window can't drive it to zero
 * (or negative). Shared by the summarizer and the overview builder so they can't
 * drift on how much input they pack per call.
 */
export function memoryInputBudget(
	contextWindow: number,
	maxTokens: number,
	overheadTokens: number,
	minBudget: number,
): number {
	const usable = Math.floor(contextWindow * MEMORY_BUDGET_SAFETY_FRACTION);
	return Math.max(usable - maxTokens - overheadTokens, minBudget);
}

/** Budget options for one memory pass, as passed to {@link memoryInputBudget}. */
export type BudgetOpts = { maxTokens: number; overheadTokens: number; minBudget: number };

/** How many times a pass may re-run against a smaller budget before giving up. */
const MAX_OVERFLOW_RETRIES = 3;
/** Minimum shrink per retry, so a vendor that names the overflow but reports no
 *  numbers still converges instead of re-sending a near-identical payload. */
const OVERFLOW_SHRINK_FACTOR = 0.6;

/**
 * The input budget to use after the upstream rejected a payload as too large, or
 * null when the error wasn't an overflow (rethrow) or we're already as small as
 * we go (give up — the caller skips the item).
 *
 * The rejection carries what actually fits (`n_ctx`) and what we actually sent
 * (`n_prompt_tokens`) — both measured with the upstream's real tokenizer. Their
 * ratio is exactly the correction factor our `chars/4` estimate was missing, so
 * scaling the estimated budget by it lands the next attempt under the true window
 * whether we were wrong about the window, wrong about the tokenizer, or both.
 */
export function shrinkBudgetAfterOverflow(
	e: unknown,
	budget: number,
	opts: BudgetOpts,
): number | null {
	const overflow = parseContextOverflow(e);
	if (!overflow) return null;

	// Trust the upstream's window over the configured/advertised one. With no
	// reported numbers, both terms collapse to the current budget and the flat
	// shrink factor below carries the retry.
	const allowed =
		overflow.contextWindow > 0
			? memoryInputBudget(overflow.contextWindow, opts.maxTokens, opts.overheadTokens, 0)
			: budget;
	const scaled =
		overflow.promptTokens > 0 ? Math.floor((budget * allowed) / overflow.promptTokens) : budget;

	const next = Math.max(
		Math.min(scaled, Math.floor(budget * OVERFLOW_SHRINK_FACTOR)),
		opts.minBudget,
	);
	// Already at the floor and still overflowing: nothing left to give.
	return next < budget ? next : null;
}

/**
 * Run a memory pass, re-running it against a smaller input budget each time the
 * upstream rejects the payload as too large. `run` must be a pure function of the
 * budget (it re-chunks from scratch), so a retry is just a cheaper re-do.
 *
 * This is what makes the background passes self-correcting rather than dependent
 * on getting the window config and the token estimate right up front: the first
 * overflow tells us the truth and the retry uses it. Exhausting the retries
 * rethrows the original 4xx, which `isPermanentRequestError` classifies as
 * skippable so one un-summarizable conversation can't wedge the sweep.
 */
export async function withOverflowRetry<T>(
	initialBudget: number,
	opts: BudgetOpts,
	run: (budget: number) => Promise<T>,
): Promise<T> {
	let budget = initialBudget;
	for (let attempt = 0; ; attempt++) {
		try {
			return await run(budget);
		} catch (e) {
			const next =
				attempt < MAX_OVERFLOW_RETRIES ? shrinkBudgetAfterOverflow(e, budget, opts) : null;
			if (next === null) throw e;
			console.warn(
				`[memory] upstream rejected a ${budget}-token input budget as over-window; retrying at ${next}`,
			);
			budget = next;
		}
	}
}

/**
 * One memory-model call. Queues on the shared per-endpoint slot (released even on
 * error): a background pass makes several calls, so slotting PER CALL lets a
 * waiting live chat slip between them — a fair peer, never a preempting or
 * endpoint-hogging one. Returns the trimmed completion text.
 */
export async function callMemoryModel(
	model: ResolvedMemoryModel,
	systemPrompt: string,
	userContent: string,
	signal?: AbortSignal,
): Promise<string> {
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

/**
 * Split one string into pieces that each fit `budget`, breaking at the last
 * paragraph/line/space before the limit so pieces stay readable. A no-op for a
 * string already within budget.
 *
 * Without this, a single item larger than the budget (one enormous pasted
 * message) becomes its own over-budget chunk that NO budget can shrink into
 * range — the overflow retry would shrink forever and still send the same
 * oversized payload. This is the base case that makes shrinking converge.
 */
export function splitToBudget(s: string, budget: number): string[] {
	if (budget <= 0 || approxTokens(s) <= budget) return [s];
	const maxChars = budget * 4; // inverse of approxTokens
	const pieces: string[] = [];
	let rest = s;
	while (approxTokens(rest) > budget) {
		const head = rest.slice(0, maxChars);
		// Break at the last structural boundary in the back half; a run with no
		// break at all (minified blob) falls back to a hard slice.
		const floor = Math.floor(head.length / 2);
		let cut = head.lastIndexOf('\n\n');
		if (cut < floor) cut = head.lastIndexOf('\n');
		if (cut < floor) cut = head.lastIndexOf(' ');
		if (cut < floor) cut = head.length;
		pieces.push(rest.slice(0, cut).trim());
		rest = rest.slice(cut).trim();
	}
	if (rest.length > 0) pieces.push(rest);
	return pieces;
}

/**
 * Trim to `max` characters, cutting at the last clean boundary — a complete line,
 * else a sentence end, else a word break — so stored text never ends mid-word or
 * mid-sentence. Only a boundary in the back half is accepted, so one long
 * unbroken run degrades to a word break rather than collapsing to a fragment.
 *
 * The caps exist because the model is ASKED for a length and routinely overshoots
 * it (LLMs can't count characters), so the cap is load-bearing, not defensive — it
 * fires often enough that where it cuts is user-visible.
 */
export function capAtBoundary(s: string, max: number): string {
	const t = s.trim();
	// A missing/garbage cap must not silently reduce the text to an ellipsis — a
	// nonsense limit is a bug worth seeing, and losing the content hides it.
	if (!Number.isFinite(max) || max <= 1) return t;
	if (t.length <= max) return t;

	const head = t.slice(0, max - 1); // leave room for the ellipsis
	const floor = Math.floor(head.length / 2);
	let cut = head.lastIndexOf('\n');
	if (cut < floor) cut = lastSentenceEnd(head);
	if (cut < floor) {
		// Nothing structural to land on, so just keep whole words — and if the cut
		// already fell between two words, keep all of them.
		cut = /\s/.test(t[head.length]) ? head.length : head.lastIndexOf(' ');
	}
	const kept = cut >= floor ? head.slice(0, cut) : head;
	return kept.trimEnd() + '…';
}

/** Index just past the final sentence-ending punctuation in `s`, or -1. */
function lastSentenceEnd(s: string): number {
	let last = -1;
	for (const m of s.matchAll(/[.!?][)\]"'”’]?(?=\s|$)/g)) {
		last = m.index + m[0].length;
	}
	return last;
}

/** Greedily group strings so each group's estimated tokens stay within `budget`.
 *  A single over-budget item becomes its own group — pre-split with
 *  {@link splitToBudget} when the caller needs a hard guarantee. */
export function chunkStrings(items: string[], budget: number): string[][] {
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
