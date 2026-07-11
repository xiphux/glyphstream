/**
 * Shared plumbing for the memory model's background text passes (per-conversation
 * summaries and the orientation overview): a slot-queued single call, a token
 * estimate, and greedy string batching. Kept in one place so the summarizer and
 * the overview builder can't drift on how they call the model or budget input.
 */

import { chatCompletionSync } from '../endpoints/client';
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

/** Greedily group strings so each group's estimated tokens stay within `budget`.
 *  A single over-budget item becomes its own group. */
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
