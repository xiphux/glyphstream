/**
 * Conversation compaction engine. Summarizes a conversation's older history
 * through its **own** model (not the task model — fidelity matters here) and
 * appends the summary as an assistant message tagged with
 * `compactionResumeFromMessageId`. From then on `serializeBranchForUpstream`
 * trims the upstream payload to `[summary, ...verbatim tail]` while the real
 * turns stay in the tree (non-lossy).
 *
 * Shared by the manual `POST /compact` endpoint and the just-in-time auto path
 * in the send handler.
 */

import { getConversationMeta } from '../db/queries/conversations';
import { appendMessage, walkActiveBranch } from '../db/queries/messages';
import { chatCompletionSync, type ChatCompletionRequest } from '../endpoints/client';
import type { LoadedEndpoint, ProviderQuirk } from '../endpoints/config';
import { getEndpoint } from '../endpoints/registry';
import { parseModelId } from '../endpoints/model-id';
import { serializeMessageForUpstream } from '../endpoints/serialize-upstream';
import { mediaIdToDataUrl } from '../media/data-url';
import { renderMarkdown } from '../markdown/render';
import { computeCompactionCut, DEFAULT_KEEP_TURNS, upstreamBranch } from '$lib/chat-compaction';
import type { ChatMessage } from '$lib/types/api';

// Task framing for the summarizer. Kept separate from the conversation's own
// system prompt so the persona doesn't pull the model into "staying in
// character" instead of producing notes.
const SUMMARY_SYSTEM =
	'You are compacting a conversation to free up context space. Read the ' +
	'conversation so far and produce a faithful, self-contained summary that lets ' +
	'the assistant continue seamlessly. Preserve key facts, decisions, the user’s ' +
	'preferences and constraints, names and identifiers, code and file paths, ' +
	'unresolved questions, and the current state of the task. Be concise but ' +
	'complete. Write the summary as notes for yourself, not as a reply to the ' +
	'user, and do not comment on the act of summarizing.';

// Restated as the final turn so weaker models don't try to continue the
// transcript instead of summarizing it (same guard the title task uses).
const SUMMARY_INSTRUCTION =
	'Summarize the conversation above into a concise but complete brief, following ' +
	'the system instructions. Output only the summary.';

// Generous cap: a faithful brief needs room, but this bounds a runaway model
// and helps the summarization call fit alongside the near-full history.
const SUMMARY_MAX_TOKENS = 1024;

const SUMMARY_TEMPERATURE = 0.3;

/**
 * Everything needed to run a compaction's summarization call and persist the
 * result, computed without contacting the model. Lets the sync engine
 * (`runCompaction`) and the streaming relay (`streamCompaction`) share the same
 * preparation and persistence while differing only in how they call the model.
 */
export interface CompactionPlan {
	endpoint: LoadedEndpoint;
	upstreamId: string;
	providerQuirk: ProviderQuirk;
	/** The conversation's stored model id, recorded on the summary's `modelUsed`. */
	storedModelId: string;
	/** Ready-to-send summarization request messages. */
	messages: ChatCompletionRequest['messages'];
	/** First message kept verbatim — stored on the summary as its resume point. */
	resumeMessageId: string;
	/** The active leaf the summary is appended under. */
	parentLeafId: string;
	maxTokens: number;
	temperature: number;
}

/**
 * Plan a compaction without calling the model. Returns null when there's
 * nothing worth compacting (too short, only a prior summary to fold) or the
 * conversation's model can't be resolved. Cheap: no upstream request.
 */
export async function prepareCompaction(
	conversationId: string,
	userId: string,
	opts: { keepTurns?: number } = {},
): Promise<CompactionPlan | null> {
	const keepTurns = opts.keepTurns ?? DEFAULT_KEEP_TURNS;

	const meta = getConversationMeta(conversationId, userId);
	if (!meta) return null;

	const parsed = parseModelId(meta.modelId);
	const endpoint = parsed ? getEndpoint(parsed.endpointId) : null;
	if (!parsed || !endpoint) return null;

	const branch = walkActiveBranch(conversationId);
	if (branch.length === 0) return null;

	// Compact the current *model-visible* view, so an earlier summary folds into
	// the new one rather than being summarized twice or dropped.
	const view = upstreamBranch(branch);
	const cut = computeCompactionCut(view, keepTurns);
	if (!cut) return null;

	// Serialize the slice to summarize per-message — NOT via
	// serializeBranchForUpstream, which would re-trim around the very summary
	// we're trying to fold in.
	const resolveMediaUrl = (mediaId: string) => mediaIdToDataUrl(mediaId, userId);
	const serialized: ChatCompletionRequest['messages'] = [];
	for (const m of view.slice(0, cut.cutIndex)) {
		const s = await serializeMessageForUpstream(m, resolveMediaUrl);
		if (s) serialized.push(s);
	}

	const messages: ChatCompletionRequest['messages'] = [
		{ role: 'system', content: SUMMARY_SYSTEM },
		...serialized,
		{ role: 'user', content: SUMMARY_INSTRUCTION },
	];

	// Append at the active leaf so the summary sits physically at the tip;
	// `splitAtCompaction` repositions it logically via the resume pointer.
	const leaf = branch[branch.length - 1];

	return {
		endpoint,
		upstreamId: parsed.upstreamId,
		providerQuirk: endpoint.providerQuirk,
		storedModelId: meta.modelId,
		messages,
		resumeMessageId: cut.resumeMessageId,
		parentLeafId: leaf.id,
		maxTokens: SUMMARY_MAX_TOKENS,
		temperature: SUMMARY_TEMPERATURE,
	};
}

/**
 * Persist a generated summary as the compaction-anchor message. Shared by the
 * sync and streaming paths so the row shape (marker, content_html, leaf
 * advance) can't drift between them. Returns the persisted message.
 */
export async function persistCompactionSummary(
	conversationId: string,
	plan: CompactionPlan,
	summaryText: string,
): Promise<ChatMessage> {
	const contentHtml = await renderMarkdown(summaryText);
	return appendMessage({
		conversationId,
		parentMessageId: plan.parentLeafId,
		role: 'assistant',
		parts: [{ type: 'text', text: summaryText }],
		contentHtml,
		modelUsed: plan.storedModelId,
		compactionResumeFromMessageId: plan.resumeMessageId,
		advanceActiveLeaf: true,
	});
}

export type CompactionResult =
	| { status: 'compacted'; summaryMessageId: string }
	| { status: 'noop' };

/**
 * Synchronous compaction — plan, call the model once (blocking), persist.
 * Used by the just-in-time auto path in the send handler. Returns
 * `{status:'noop'}` when there's nothing to compact; throws `UpstreamError` if
 * the summarization call fails (callers decide fatal vs. swallowed).
 */
export async function runCompaction(
	conversationId: string,
	userId: string,
	opts: { keepTurns?: number } = {},
): Promise<CompactionResult> {
	const plan = await prepareCompaction(conversationId, userId, opts);
	if (!plan) return { status: 'noop' };

	const resp = await chatCompletionSync(plan.endpoint, {
		model: plan.upstreamId,
		messages: plan.messages,
		temperature: plan.temperature,
		max_tokens: plan.maxTokens,
	});
	const summaryText = (resp.choices?.[0]?.message?.content ?? '').trim();
	if (!summaryText) return { status: 'noop' };

	const summaryMsg = await persistCompactionSummary(conversationId, plan, summaryText);
	return { status: 'compacted', summaryMessageId: summaryMsg.id };
}
