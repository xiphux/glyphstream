/**
 * Conversation compaction — pure, client-safe logic shared by the server
 * (upstream serialization + the compaction engine) and the client (rendering
 * + the manual "Compact" affordance).
 *
 * The model: when a conversation outgrows its window, we *summarize* the older
 * history through the conversation's own model and append that summary as an
 * assistant message at the active leaf, tagged with
 * `compactionResumeFromMessageId` — the id of the first message kept verbatim
 * after the summary. Nothing is deleted (we own the DB), so the real turns stay
 * in the tree; only the **upstream payload** is trimmed.
 *
 * A summary is physically appended at the leaf but belongs *logically* at the
 * cut point. These helpers reconcile that:
 *
 *   - `splitAtCompaction` / `upstreamBranch` — what the model sees: the latest
 *     summary leads, followed by the verbatim tail and any later turns;
 *     everything the summary stands in for is dropped.
 *   - `arrangeForDisplay` — what the user sees: every real message stays
 *     visible inline, each summary repositioned to just before the turn it
 *     resumes from (rendered as a collapsed divider by the UI).
 *
 * Both are pure over `ChatMessage[]` (root → leaf order) and unit-tested.
 */

import type { ChatMessage } from '$lib/types/api';

/** How many trailing turns (each beginning at a user message) compaction keeps
 *  verbatim below the summary, so the model continues with sharp recent
 *  context. A "turn" is anchored at a user message. */
export const DEFAULT_KEEP_TURNS = 2;

/** A message is a compaction summary iff it carries a resume pointer. */
export function isCompactionSummary(m: ChatMessage): boolean {
	return m.compactionResumeFromMessageId != null;
}

export interface CompactionCut {
	/** Index (into the sequence passed to `computeCompactionCut`) of the first
	 *  message kept verbatim — the summary stands in for everything before it. */
	cutIndex: number;
	/** Id of that first-kept message, stored on the summary as its resume point. */
	resumeMessageId: string;
}

/**
 * Decide where to cut a message sequence for compaction, keeping the last
 * `keepTurns` turns verbatim. Operates on whatever sequence the caller passes —
 * for a repeat compaction that's the current *upstream view*
 * (`upstreamBranch`), so a prior summary folds into the new one.
 *
 * Returns null when there's nothing worth compacting: too few turns, or the
 * portion that would be summarized holds nothing but an earlier summary (no new
 * material to fold).
 */
export function computeCompactionCut(
	messages: ChatMessage[],
	keepTurns: number = DEFAULT_KEEP_TURNS,
): CompactionCut | null {
	if (keepTurns < 1) keepTurns = 1;
	const userIdxs: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		if (messages[i].role === 'user') userIdxs.push(i);
	}
	// Need at least one full turn to summarize beyond the ones we keep.
	if (userIdxs.length <= keepTurns) return null;

	const resumeIdx = userIdxs[userIdxs.length - keepTurns];
	if (resumeIdx <= 0) return null;

	// The summarized slice must contain real material — not just a prior
	// summary — otherwise we'd burn a model call re-summarizing a summary.
	const hasRealMaterial = messages.slice(0, resumeIdx).some((m) => !isCompactionSummary(m));
	if (!hasRealMaterial) return null;

	return { cutIndex: resumeIdx, resumeMessageId: messages[resumeIdx].id };
}

export interface CompactionSplit {
	/** Messages the latest summary stands in for — kept in the UI, dropped
	 *  from the upstream payload. Empty when the branch has no summary. */
	summarized: ChatMessage[];
	/** The latest compaction summary, or null when there is none. */
	summary: ChatMessage | null;
	/** Verbatim tail + any turns added after the summary, in order. Equals the
	 *  whole branch when there is no summary. */
	live: ChatMessage[];
}

/**
 * Partition a root→leaf branch around its **latest** compaction summary. The
 * summary is physically at (or near) the leaf but its resume pointer names the
 * first verbatim-kept message earlier in the branch, so:
 *
 *   summarized = branch[0 .. resume-1]
 *   summary    = S
 *   live       = branch[resume .. S-1]  ++  branch[S+1 .. end]
 *
 * With no summary present: `{ summarized: [], summary: null, live: branch }`.
 */
export function splitAtCompaction(branch: ChatMessage[]): CompactionSplit {
	let summaryIdx = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		if (isCompactionSummary(branch[i])) {
			summaryIdx = i;
			break;
		}
	}
	if (summaryIdx === -1) {
		return { summarized: [], summary: null, live: branch };
	}

	const summary = branch[summaryIdx];
	const resumeId = summary.compactionResumeFromMessageId;
	let resumeIdx = branch.findIndex((m) => m.id === resumeId);
	// Defensive: a dangling resume pointer (target deleted) degrades to "no
	// verbatim tail" rather than throwing — the summary still leads upstream.
	if (resumeIdx === -1 || resumeIdx > summaryIdx) resumeIdx = summaryIdx;

	return {
		summarized: branch.slice(0, resumeIdx),
		summary,
		// Drop any *older* summaries caught in the verbatim range — their content
		// is already folded into the latest summary, so shipping them upstream is
		// redundant. (Display handles older summaries separately via
		// `arrangeForDisplay`.)
		live: [...branch.slice(resumeIdx, summaryIdx), ...branch.slice(summaryIdx + 1)].filter(
			(m) => !isCompactionSummary(m),
		),
	};
}

/**
 * The sequence to serialize upstream: `[summary, ...live]` when compacted, or
 * the untouched branch otherwise. This is the single trim point — feed it to
 * `serializeBranchForUpstream`.
 */
export function upstreamBranch(branch: ChatMessage[]): ChatMessage[] {
	const { summary, live } = splitAtCompaction(branch);
	return summary ? [summary, ...live] : live;
}

/**
 * Reorder a root→leaf branch for display: every real message stays, but each
 * summary is moved from its physical leaf position to immediately before the
 * turn it resumes from — its logical home. The UI renders summaries (detected
 * via `isCompactionSummary`) as collapsed dividers and everything else inline.
 *
 * Handles repeated compaction (multiple summaries) by placing each before its
 * own resume target; a summary whose target is missing is appended at the end.
 */
export function arrangeForDisplay(branch: ChatMessage[]): ChatMessage[] {
	const summaries = branch.filter(isCompactionSummary);
	if (summaries.length === 0) return branch;

	const summaryIds = new Set(summaries.map((s) => s.id));
	const byResume = new Map<string, ChatMessage>();
	for (const s of summaries) {
		if (s.compactionResumeFromMessageId) byResume.set(s.compactionResumeFromMessageId, s);
	}

	const out: ChatMessage[] = [];
	for (const m of branch) {
		if (summaryIds.has(m.id)) continue; // placed via its resume target below
		const s = byResume.get(m.id);
		if (s) out.push(s);
		out.push(m);
	}
	// Any summary whose resume target wasn't found — keep it visible at the end.
	const placed = new Set(out.filter(isCompactionSummary).map((s) => s.id));
	for (const s of summaries) {
		if (!placed.has(s.id)) out.push(s);
	}
	return out;
}

/** Whether a manual/auto compaction is structurally possible (enough turns to
 *  fold). Says nothing about whether it's *worth it* — see `compactionWorthwhile`. */
export function canCompact(branch: ChatMessage[], keepTurns: number = DEFAULT_KEEP_TURNS): boolean {
	return computeCompactionCut(upstreamBranch(branch), keepTurns) !== null;
}

/**
 * Rough token estimate (chars / 4) of what these messages contribute to the
 * upstream payload. There's no tokenizer on the client; this only gates "is
 * there enough history to bother compacting?", where an approximation is fine.
 *
 * Counts ALL the text-bearing content compaction would fold — not just `text`
 * parts. Tool-heavy turns (code execution, PDF/file ops) carry their bulk in
 * `tool_call` arguments and `tool_result` outputs; counting text alone badly
 * undercounts them and wrongly reports a large conversation as not worth
 * compacting. (Reasoning isn't sent upstream, and images/files have no
 * char-countable token cost, so both are skipped.)
 */
export function estimateContentTokens(messages: ChatMessage[]): number {
	let chars = 0;
	for (const m of messages) {
		for (const p of m.parts) {
			if (p.type === 'text') chars += p.text.length;
			else if (p.type === 'tool_call') chars += p.toolName.length + p.arguments.length;
			else if (p.type === 'tool_result') chars += p.result.length;
		}
	}
	return Math.ceil(chars / 4);
}

/**
 * Minimum estimated tokens of foldable history for compaction to be worth
 * offering/firing. Compaction only shrinks the message history — not the system
 * prompt, tool definitions, or saved memories, which are re-sent every turn — so
 * when the history is tiny (a few short turns) a summary saves little or even
 * costs more than it folds. Below this floor we leave the button disabled and
 * hold auto-compaction off, even when the *total* prompt (overhead + history)
 * is over the user's threshold.
 */
export const MIN_COMPACTIBLE_TOKENS = 1000;

/**
 * Whether compaction would meaningfully shrink the payload: structurally
 * possible AND the history it would fold is large enough to be worth it. This is
 * the gate the manual button and auto-compaction actually use (vs. the purely
 * structural `canCompact`).
 */
export function compactionWorthwhile(
	branch: ChatMessage[],
	keepTurns: number = DEFAULT_KEEP_TURNS,
	minTokens: number = MIN_COMPACTIBLE_TOKENS,
): boolean {
	const view = upstreamBranch(branch);
	const cut = computeCompactionCut(view, keepTurns);
	if (!cut) return false;
	// The messages that would be folded into the summary = everything before the
	// verbatim tail. (For a repeat compaction this includes the prior summary,
	// which is correctly re-folded.)
	return estimateContentTokens(view.slice(0, cut.cutIndex)) >= minTokens;
}

/** Sum of an assistant message's reported prompt + completion tokens, or 0. */
function usageTokens(m: ChatMessage): number {
	return (m.tokensIn ?? 0) + (m.tokensOut ?? 0);
}

/**
 * Tokens to *display* as the current context size. Scans back for the most
 * recent assistant turn's reported usage, but ignores anything at or before the
 * latest summary's creation — a freshly compacted thread has no post-summary
 * usage yet, so this reads 0 (header drops to a bare count) and self-corrects to
 * the real, smaller number once the next turn returns its usage. Avoids briefly
 * showing the stale pre-compaction figure after a manual Compact.
 */
export function displayContextTokens(branch: ChatMessage[]): number {
	let floor = -Infinity;
	for (const m of branch) {
		if (isCompactionSummary(m) && m.createdAt > floor) floor = m.createdAt;
	}
	for (let i = branch.length - 1; i >= 0; i--) {
		const m = branch[i];
		if (m.role !== 'assistant' || isCompactionSummary(m)) continue;
		if (m.createdAt <= floor) continue;
		const t = usageTokens(m);
		if (t > 0) return t;
	}
	return 0;
}

/**
 * Tokens the *next* request will roughly carry, from the most recent real
 * assistant turn's usage (unscoped — this is the live size used to decide
 * whether to auto-compact, not the post-compaction display figure).
 */
export function currentContextTokens(branch: ChatMessage[]): number {
	for (let i = branch.length - 1; i >= 0; i--) {
		const m = branch[i];
		if (m.role !== 'assistant' || isCompactionSummary(m)) continue;
		const t = usageTokens(m);
		if (t > 0) return t;
	}
	return 0;
}

/**
 * Should auto-compaction fire just-in-time before processing the next message?
 * True only when enabled, the window is known, the latest turn already sits at
 * or past the threshold, AND compaction is actually worthwhile (enough foldable
 * history — which also stops it churning on memory/tool-heavy threads where the
 * total is over threshold but the history itself is tiny).
 */
export function shouldAutoCompact(opts: {
	branch: ChatMessage[];
	enabled: boolean;
	contextWindow: number | null | undefined;
	/** Percent of the window, 0–100. */
	threshold: number;
	keepTurns?: number;
}): boolean {
	const { branch, enabled, contextWindow, threshold } = opts;
	if (!enabled) return false;
	if (!contextWindow || contextWindow <= 0) return false;
	if (threshold <= 0) return false;
	const used = currentContextTokens(branch);
	if (used < (contextWindow * threshold) / 100) return false;
	return compactionWorthwhile(branch, opts.keepTurns ?? DEFAULT_KEEP_TURNS);
}
