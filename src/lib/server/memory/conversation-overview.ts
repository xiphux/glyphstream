/**
 * Builds a user's orientation overview: a compact, STRUCTURED map of the topics
 * they've discussed across conversations, rebuilt from their per-conversation
 * summaries. Injected into the persona system prompt so the model knows what past
 * threads exist to `search_conversations`. Runs on the `[memory_model]` via the
 * summary worker's overview phase.
 *
 * Rebuild-from-all (not incremental) so deletions/re-summarizations always
 * propagate and no cruft accretes. Two stability measures keep it from churning
 * each rebuild: summaries arrive in a deterministic order (created_at) and the
 * previous overview is passed as a *structural anchor* — content is re-derived
 * from the summaries, but its organization/ordering is kept stable. Over-window
 * users (rare) fall back to an iterative fold (structure best-effort).
 */

import { approxTokens, callMemoryModel, chunkStrings } from './summarize-util';
import type { ResolvedMemoryModel } from '../tasks/memory-model';

/** Hard cap on the stored/injected overview — it rides in the system prompt every
 *  personalization-on turn, so it stays a bounded signpost. */
export const OVERVIEW_MAX_CHARS = 1500;

const PROMPT_OVERHEAD_TOKENS = 500;
const DEFAULT_CONTEXT_WINDOW = 8000;
const MIN_BUDGET_TOKENS = 1000;

const BUILD_PROMPT = `You maintain a compact, STRUCTURED map of the topics a user has discussed with an assistant across many conversations. The assistant reads this map to know what past conversations exist so it can search them. Given the user's conversation summaries (and the previous map), produce an updated map:
- Group related topics under a few short thematic headings; put the most significant or recurring themes first.
- Under each heading, a brief phrase per notable topic. Merge duplicates; drop trivia.
- Base the CONTENT entirely on the summaries provided. Do NOT carry over anything from the previous map that the summaries no longer support — conversations may have been deleted or changed. Use the previous map ONLY to keep the structure and ordering stable between updates.
- Keep the whole map under ${OVERVIEW_MAX_CHARS} characters. It is a signpost for search, not an exhaustive log. Output only the map, no preamble.`;

const FOLD_PROMPT = `You are building a compact, STRUCTURED map of the topics a user has discussed, in batches. Given the map so far and more conversation summaries, return the updated map: group related topics under short thematic headings (most significant first), a brief phrase per topic, merge duplicates, drop trivia. Keep it under ${OVERVIEW_MAX_CHARS} characters. Output only the map, no preamble.`;

/** Trim + hard-cap, preserving newlines (it's prompt text / a structured list,
 *  not a single-line FTS row). */
function capOverview(s: string): string {
	const t = s.trim();
	return t.length <= OVERVIEW_MAX_CHARS ? t : t.slice(0, OVERVIEW_MAX_CHARS - 1).trimEnd() + '…';
}

function renderSummaries(summaries: string[]): string {
	return summaries.map((s) => `- ${s}`).join('\n');
}

/**
 * Rebuild the overview from all of a user's conversation summaries (deterministic
 * order — caller sorts). `previousOverview` anchors structure only. Returns the
 * capped map; with no summaries it falls back to the previous overview (trimmed —
 * already capped when it was built), or '' if there is none either. In practice
 * the no-summaries case is defensive: the worker only calls this for users the
 * watermark query found with ≥1 summary, and an overview whose conversations are
 * all deleted is cleared at delete time (see reconcileOverviewAfterConversationDelete).
 */
export async function buildOverview(
	model: ResolvedMemoryModel,
	previousOverview: string | null,
	summaries: string[],
	contextWindow: number | null,
	signal?: AbortSignal,
): Promise<string> {
	if (summaries.length === 0) return (previousOverview ?? '').trim();
	const budget = Math.max(
		(contextWindow ?? DEFAULT_CONTEXT_WINDOW) - model.maxTokens - PROMPT_OVERHEAD_TOKENS,
		MIN_BUDGET_TOKENS,
	);
	const prev = (previousOverview ?? '').trim();

	// Common path: the whole set fits one call — most stable + structured.
	if (approxTokens(prev + '\n' + renderSummaries(summaries)) <= budget) {
		const user =
			`Previous map (for structure/order continuity only):\n${prev || '(none yet)'}\n\n` +
			`Conversation summaries (source of truth, oldest first):\n${renderSummaries(summaries)}`;
		return capOverview(await callMemoryModel(model, BUILD_PROMPT, user, signal));
	}

	// Over-window (rare, huge user): iterative fold over ordered batches, seeded
	// empty (true rebuild — no cruft). Reserve room for the growing map by batching
	// summaries at a fraction of the budget. Structure stability is best-effort here.
	const foldBudget = Math.max(Math.floor(budget / 2), MIN_BUDGET_TOKENS / 2);
	let map = '';
	for (const batch of chunkStrings(summaries, foldBudget)) {
		const user = `Map so far:\n${map || '(none yet)'}\n\nMore conversation summaries:\n${renderSummaries(batch)}`;
		map = await callMemoryModel(model, FOLD_PROMPT, user, signal);
	}
	return capOverview(map);
}
