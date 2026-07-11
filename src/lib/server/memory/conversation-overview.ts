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
 *
 * Its size is `[memory_model] overview_max_chars` (default 2500). The map does not
 * grow with the corpus — it's a bounded SIGNPOST telling the model which threads
 * exist to search, not a record of them, so it needs roughly a line per theme and
 * themes accumulate far more slowly than conversations do. It also rides in the
 * system prompt on every personalization-on turn, so every character is a
 * recurring token cost; raise the cap only if the map actually goes thin.
 */

import {
	approxTokens,
	callMemoryModel,
	capAtBoundary,
	chunkStrings,
	memoryInputBudget,
	withOverflowRetry,
} from './summarize-util';
import type { ResolvedMemoryModel } from '../tasks/memory-model';

const PROMPT_OVERHEAD_TOKENS = 500;
const DEFAULT_CONTEXT_WINDOW = 8000;
const MIN_BUDGET_TOKENS = 1000;

// The size of the map is `[memory_model] overview_max_chars` (default 2500). It's
// told to the model AND enforced afterwards: an LLM can't count characters, so it
// overshoots a stated budget routinely and the cap is what actually holds.
const buildPrompt = (maxChars: number) =>
	`You maintain a compact, STRUCTURED map of the topics a user has discussed with an assistant across many conversations. The assistant reads this map to know what past conversations exist so it can search them. Given the user's conversation summaries (and the previous map), produce an updated map:
- Group related topics under a few short thematic headings; put the most significant or recurring themes first.
- Under each heading, a brief phrase per notable topic. Merge duplicates; drop trivia.
- Base the CONTENT entirely on the summaries provided. Do NOT carry over anything from the previous map that the summaries no longer support — conversations may have been deleted or changed. Use the previous map ONLY to keep the structure and ordering stable between updates.
- Keep the whole map under ${maxChars} characters. It is a signpost for search, not an exhaustive log. Output only the map, no preamble.`;

const foldPrompt = (maxChars: number) =>
	`You are building a compact, STRUCTURED map of the topics a user has discussed, in batches. Given the map so far and more conversation summaries, return the updated map: group related topics under short thematic headings (most significant first), a brief phrase per topic, merge duplicates, drop trivia. Keep it under ${maxChars} characters. Output only the map, no preamble.`;

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
	const prev = (previousOverview ?? '').trim();
	// An over-window rejection re-runs this against a budget corrected by the
	// upstream's own token counts (see `withOverflowRetry`) — a shrunk budget just
	// tips the one-shot path into the fold path, which is exactly what's wanted.
	const map = await withOverflowRetry(budget, opts, (b) =>
		composeOverview(model, prev, summaries, b, signal),
	);
	// Cut at the last complete line: the model overshoots the stated budget often
	// enough that a raw slice would routinely leave the stored map mid-sentence.
	return capAtBoundary(map, model.overviewMaxChars);
}

/** The overview text for a given input budget: one-shot when everything fits,
 *  otherwise an iterative fold. Pure in `budget`, so it is safe to re-run. */
async function composeOverview(
	model: ResolvedMemoryModel,
	prev: string,
	summaries: string[],
	budget: number,
	signal?: AbortSignal,
): Promise<string> {
	// Common path: the whole set fits one call — most stable + structured.
	if (approxTokens(prev + '\n' + renderSummaries(summaries)) <= budget) {
		const user =
			`Previous map (for structure/order continuity only):\n${prev || '(none yet)'}\n\n` +
			`Conversation summaries (source of truth, oldest first):\n${renderSummaries(summaries)}`;
		return callMemoryModel(model, buildPrompt(model.overviewMaxChars), user, signal);
	}

	// Over-window (rare, huge user): iterative fold over ordered batches, seeded
	// empty (true rebuild — no cruft). Reserve room for the growing map by batching
	// summaries at a fraction of the budget. Structure stability is best-effort here.
	const foldBudget = Math.max(Math.floor(budget / 2), MIN_BUDGET_TOKENS / 2);
	let map = '';
	for (const batch of chunkStrings(summaries, foldBudget)) {
		const user = `Map so far:\n${map || '(none yet)'}\n\nMore conversation summaries:\n${renderSummaries(batch)}`;
		map = await callMemoryModel(model, foldPrompt(model.overviewMaxChars), user, signal);
	}
	return map;
}
