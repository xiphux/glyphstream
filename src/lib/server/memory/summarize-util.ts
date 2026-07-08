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
