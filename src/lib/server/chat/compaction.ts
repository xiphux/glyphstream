/**
 * Conversation compaction engine. Summarizes a conversation's older history
 * through its **own** model (not the task model — fidelity matters here) and
 * appends the summary as an assistant message tagged with
 * `compactionResumeFromMessageId`. From then on `serializeBranchForUpstream`
 * trims the upstream payload to `[summary, ...verbatim tail]` while the real
 * turns stay in the tree (non-lossy).
 *
 * Both manual and auto-compaction go through `POST /compact` (auto-compaction
 * is client-driven — see `maybeAutoCompact` in the chat page); there is no
 * server-side auto path in the send handler. `prepareCompaction` +
 * `persistCompactionSummary` are shared by the sync engine here and the
 * streaming relay (`streamCompaction`).
 */

import { getConversationMeta } from '../db/queries/conversations';
import { appendMessage, truncateAtMessage, walkActiveBranch } from '../db/queries/messages';
import { chatCompletionSync, type ChatCompletionRequest } from '../endpoints/client';
import { acquireEndpointSlot } from '../endpoints/concurrency';
import type { LoadedEndpoint, ProviderQuirk } from '../endpoints/config';
import { getEndpoint } from '../endpoints/registry';
import { parseModelId } from '../endpoints/model-id';
import { serializeMessageForUpstream } from '../endpoints/serialize-upstream';
import { mediaIdToDataUrl } from '../media/data-url';
import { renderMarkdown } from '../markdown/render';
import { listAllModels } from '../endpoints/list-models';
import {
	computeCompactionCut,
	DEFAULT_KEEP_TURNS,
	estimateContentTokens,
	isCompactionSummary,
	summaryMaxTokens,
	upstreamBranch,
} from '$lib/chat-compaction';
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

	const branch = walkActiveBranch(conversationId, { columns: 'serialization' });
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

	// Size the output budget to the room this conversation actually has. The
	// summary replaces the folded history, so the window it occupies is free to
	// spend on a fuller brief — and a too-small budget is what starves a thinking
	// summarizer into an empty completion. Resolve n_ctx the same way the client
	// does (listAllModels is cached); null when the model doesn't report one.
	const contextWindow =
		(await listAllModels()).find((m) => m.id === meta.modelId)?.contextWindow ?? null;
	const promptTokens = estimateContentTokens(view.slice(0, cut.cutIndex));

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
		maxTokens: summaryMaxTokens(promptTokens, contextWindow),
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
	{ status: 'compacted'; summaryMessageId: string } | { status: 'noop' };

/**
 * Synchronous compaction — plan, call the model once (blocking), persist.
 * Used by the non-streaming branch of `POST /api/conversations/[id]/compact`
 * (the streaming branch uses `streamCompaction` instead). Returns
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

	// Hold a per-endpoint slot so compaction doesn't preempt a live
	// generation on a single-GPU backend. Release once the upstream
	// call settles — even on error.
	const slot = await acquireEndpointSlot(plan.endpoint.id, plan.endpoint.maxConcurrent);
	try {
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
	} finally {
		slot.release();
	}
}

export type UncompactionResult = { status: 'reverted' } | { status: 'noop' };

/**
 * Undo the most recent compaction: if the active leaf is a compaction summary
 * (i.e. nothing has been sent since it was created), move the active leaf back
 * to the message it was appended under, so the conversation reverts to its
 * pre-compaction view. Non-destructive — like every other leaf move in this
 * app, the summary row stays in the tree as an inactive sibling rather than
 * being deleted, so it serializes out of the upstream payload but isn't lost.
 *
 * Gated to the active-leaf case on purpose: once a later turn parents off the
 * summary, un-compacting would mean re-homing that tail, a different operation
 * we deliberately don't do here. Returns `noop` when there's nothing to revert.
 */
export function undoCompaction(conversationId: string, userId: string): UncompactionResult {
	const meta = getConversationMeta(conversationId, userId);
	if (!meta) return { status: 'noop' };

	const branch = walkActiveBranch(conversationId, { columns: 'serialization' });
	const leaf = branch[branch.length - 1];
	if (!leaf || !isCompactionSummary(leaf)) return { status: 'noop' };

	truncateAtMessage(conversationId, leaf.id);
	return { status: 'reverted' };
}
