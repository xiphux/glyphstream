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
import { getEndpoint } from '../endpoints/registry';
import { parseModelId } from '../endpoints/model-id';
import { serializeMessageForUpstream } from '../endpoints/serialize-upstream';
import { mediaIdToDataUrl } from '../media/data-url';
import { renderMarkdown } from '../markdown/render';
import { computeCompactionCut, DEFAULT_KEEP_TURNS, upstreamBranch } from '$lib/chat-compaction';

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

export type CompactionResult =
	| { status: 'compacted'; summaryMessageId: string }
	| { status: 'noop' };

/**
 * Compact the active branch of `conversationId`. Returns `{status:'noop'}` when
 * there's nothing worth compacting (too short, or only a prior summary to fold)
 * or the conversation's model can't be resolved. Throws `UpstreamError` if the
 * summarization call to the model fails — callers decide whether that's fatal
 * (manual endpoint surfaces it) or swallowed (auto path proceeds uncompacted).
 */
export async function runCompaction(
	conversationId: string,
	userId: string,
	opts: { keepTurns?: number } = {},
): Promise<CompactionResult> {
	const keepTurns = opts.keepTurns ?? DEFAULT_KEEP_TURNS;

	const meta = getConversationMeta(conversationId, userId);
	if (!meta) return { status: 'noop' };

	const parsed = parseModelId(meta.modelId);
	const endpoint = parsed ? getEndpoint(parsed.endpointId) : null;
	if (!parsed || !endpoint) return { status: 'noop' };

	const branch = walkActiveBranch(conversationId);
	if (branch.length === 0) return { status: 'noop' };

	// Compact the current *model-visible* view, so an earlier summary folds into
	// the new one rather than being summarized twice or dropped.
	const view = upstreamBranch(branch);
	const cut = computeCompactionCut(view, keepTurns);
	if (!cut) return { status: 'noop' };

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

	const resp = await chatCompletionSync(endpoint, {
		model: parsed.upstreamId,
		messages,
		temperature: 0.3,
		max_tokens: SUMMARY_MAX_TOKENS,
	});
	const summaryText = (resp.choices?.[0]?.message?.content ?? '').trim();
	if (!summaryText) return { status: 'noop' };

	const contentHtml = await renderMarkdown(summaryText);

	// Append at the active leaf so the summary sits physically at the tip;
	// `splitAtCompaction` repositions it logically via the resume pointer.
	const leaf = branch[branch.length - 1];
	const summaryMsg = appendMessage({
		conversationId,
		parentMessageId: leaf.id,
		role: 'assistant',
		parts: [{ type: 'text', text: summaryText }],
		contentHtml,
		modelUsed: meta.modelId,
		compactionResumeFromMessageId: cut.resumeMessageId,
		advanceActiveLeaf: true,
	});

	return { status: 'compacted', summaryMessageId: summaryMsg.id };
}
