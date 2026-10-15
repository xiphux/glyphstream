/**
 * Resume the per-tool-call approval flow. The chat stream halts when an
 * MCP tool needs the user's go-ahead (Allow / Allow Always / Reject);
 * the client posts decisions here. For each decision we:
 *   - load the pending tool_result row by toolCallId
 *   - find its parent assistant message's tool_call (name + arguments)
 *   - execute the tool (Allow / Allow Always) or write a declined-error
 *     result (Reject), filling in the previously-empty result and
 *     dropping the `status: 'pending_approval'` marker
 *   - `Allow Always` also appends the tool's namespaced name to the
 *     user's trustedMcpTools so future calls bypass the prompt
 *
 * Once decisions settle, we kick off a fresh SSE relay using the now-
 * completed branch as the upstream context — same code path as the
 * messages POST endpoint's tool-loop continuation.
 */

import { error } from '@sveltejs/kit';
import { requireFound, requireUser } from '#lib/server/auth/guard.js';
import { parseJsonBody } from '#lib/server/http.js';
import { getConversationMeta } from '#lib/server/db/queries/conversations.js';
import { walkActiveBranch, updateMessageParts } from '#lib/server/db/queries/messages.js';
import { linkMessageMedia } from '#lib/server/db/queries/media.js';
import { getEndpoint } from '#lib/server/endpoints/registry.js';
import { listAllModels } from '#lib/server/endpoints/list-models.js';
import { parseModelId } from '#lib/server/endpoints/model-id.js';
import { getMaxToolLoopIterations } from '#lib/server/endpoints/config.js';
import { awaitMcpReady } from '#lib/server/mcp/bootstrap.js';
import { buildChatToolContext } from '#lib/server/chat/tool-context.js';
import { buildUpstreamRequest, cachedMediaResolver } from '#lib/server/chat/upstream-request.js';
import { resolveDisabledFeatures } from '#lib/server/chat/private-seal.js';
import { getUserPreferences, setUserPreferences } from '#lib/server/db/queries/user-preferences.js';
import { composePersonaPrompt } from '#lib/server/chat/persona-context.js';
import { executeOneToolCall } from '#lib/server/streaming/tool-execution.js';
import { clearInFlight, registerInFlight } from '#lib/server/streaming/in-flight.js';
import { sseResponse } from '#lib/server/streaming/sse-transport.js';
import { startStreamingRelay } from '#lib/server/streaming/relay.js';
import { mediaIdToDataUrl } from '#lib/server/media/data-url.js';
import type { ChatCompletionRequest } from '#lib/server/endpoints/client.js';
import type { ChatMessage, MessagePart } from '#lib/types/api.js';
import type { RequestHandler } from './$types';

interface ApprovalDecision {
	toolCallId: string;
	action: 'allow' | 'allow_always' | 'reject';
}

interface ApprovalBody {
	decisions: ApprovalDecision[];
}

function isToolCallPart(p: MessagePart): p is Extract<MessagePart, { type: 'tool_call' }> {
	return p.type === 'tool_call';
}
function isToolResultPart(p: MessagePart): p is Extract<MessagePart, { type: 'tool_result' }> {
	return p.type === 'tool_result';
}

/**
 * Tool calls being executed right now, keyed `conversationId:toolCallId`.
 *
 * A pending row stops looking pending only when its result is written, which
 * happens after the tool runs. A second approval for the same call arriving in
 * between (another tab, a retry, or the same id twice in one body) would
 * otherwise run the tool again. A call is claimed synchronously right after
 * it is found pending and released once its result is written (or execution
 * failed, leaving it pending to approve again).
 */
const executingToolCalls = new Set<string>();

export const POST: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals);
	const userId = locals.user.id;

	const body = await parseJsonBody<ApprovalBody>(request);
	if (!body || !Array.isArray(body.decisions) || body.decisions.length === 0) {
		error(400, 'Expected { decisions: [{ toolCallId, action }, ...] }');
	}
	for (const d of body.decisions) {
		if (typeof d.toolCallId !== 'string' || d.toolCallId.length === 0) {
			error(400, 'Each decision needs a non-empty toolCallId');
		}
		if (d.action !== 'allow' && d.action !== 'allow_always' && d.action !== 'reject') {
			error(400, `Unknown action "${String(d.action)}"`);
		}
	}

	const meta = requireFound(getConversationMeta(params.id, userId), 'Conversation not found');
	// Effective feature opt-outs — the private-chat seal, kept identical to the
	// message-send handler (the anti-drift twin) so a private conversation seals
	// the same tool surface whether it streams fresh or resumes after an approval.
	const disabledFeatures = resolveDisabledFeatures(meta);
	const endpoint = getEndpoint(meta.endpointId);
	if (!endpoint) {
		error(409, `Endpoint "${meta.endpointId}" is no longer in config.toml`);
	}

	await awaitMcpReady();

	// Apply changes via updateMessageParts — the active-leaf doesn't move
	// because we're rewriting existing rows, not appending.
	const newlyTrusted: string[] = [];
	let updatedAny = false;

	for (const decision of body.decisions) {
		// Read the branch fresh for each decision, and claim the call in the
		// same synchronous step: a snapshot taken once before the loop goes
		// stale across the awaits below, and a concurrent request could finish
		// and release a call this request would then see as still pending.
		const branch = walkActiveBranch(params.id, { columns: 'serialization' });
		const found = findPending(branch, decision.toolCallId);
		if (!found) continue;
		const claim = `${params.id}:${decision.toolCallId}`;
		if (executingToolCalls.has(claim)) continue;
		executingToolCalls.add(claim);
		try {
			const { toolMsg, resultPart, toolCallPart } = found;
			if (decision.action === 'reject') {
				updateMessageParts(toolMsg.id, params.id, [
					{
						type: 'tool_result',
						toolCallId: resultPart.toolCallId,
						result: JSON.stringify({ error: 'User declined this tool call.' }),
						isError: true,
					},
				]);
				updatedAny = true;
				continue;
			}
			const execResult = await executeOneToolCall(
				toolCallPart,
				userId,
				params.id,
				request.signal,
				disabledFeatures,
			);
			const nextPart: Extract<MessagePart, { type: 'tool_result' }> = {
				type: 'tool_result',
				toolCallId: resultPart.toolCallId,
				result: execResult.execution.content,
				...(execResult.execution.isError ? { isError: true } : {}),
			};
			// Media MessageParts were pre-constructed by executeOneToolCall
			// (which also handles the lookup via getMediaForUser). We still
			// need to link each attached media to the tool message row.
			if (execResult.execution.attachedMediaIds?.length) {
				for (const mediaId of execResult.execution.attachedMediaIds) {
					linkMessageMedia(toolMsg.id, mediaId);
				}
			}
			if (decision.action === 'allow_always') newlyTrusted.push(toolCallPart.toolName);
			updateMessageParts(toolMsg.id, params.id, [nextPart, ...execResult.mediaParts]);
			updatedAny = true;
		} finally {
			executingToolCalls.delete(claim);
		}
	}

	if (!updatedAny) {
		error(409, 'No pending tool calls matched the decisions in this body.');
	}

	// Persist newly-trusted tools before continuing the relay so the
	// needsApproval predicate sees them on the next iteration.
	if (newlyTrusted.length > 0) {
		const existing = getUserPreferences(userId)?.trustedMcpTools ?? [];
		const merged = Array.from(new Set([...existing, ...newlyTrusted]));
		setUserPreferences(userId, { trustedMcpTools: merged });
	}

	const prefs = getUserPreferences(userId);
	let baseSystemPrompt: string | null = meta.systemPrompt;
	if (baseSystemPrompt === null) {
		baseSystemPrompt = composePersonaPrompt(prefs, userId, disabledFeatures);
	}

	const parsed = parseModelId(meta.modelId);
	if (!parsed) error(500, `Conversation modelId "${meta.modelId}" is malformed`);

	const allModels = await listAllModels();
	const modelEntry = allModels.find(
		(m) => m.endpointId === parsed.endpointId && m.upstreamId === parsed.upstreamId,
	);
	const supportsTools = modelEntry?.supportsTools ?? endpoint.supportsTools ?? false;
	if (!supportsTools) {
		// Should be impossible — we only got here because a turn earlier
		// reached pending_approval, which means tools were enabled. Defend
		// loudly.
		error(500, 'Tools no longer enabled for this conversation; cannot resume.');
	}

	// Assemble the system prompt + tool list + approval gate exactly as the
	// message-send handler does (shared buildChatToolContext) so a turn that
	// activated a skill / searched up a deferred tool / called a per-user MCP tool
	// before pausing keeps all of them on resume — without this the resumed turn
	// would silently lose them. Seeded from the post-decision branch (the
	// just-completed tool results are now part of history).
	const toolCtx = await buildChatToolContext({
		userId,
		disabledFeatures,
		supportsTools,
		baseSystemPrompt,
		branch: walkActiveBranch(params.id, { columns: 'serialization' }),
		trustedMcpTools: prefs?.trustedMcpTools ?? [],
		timeZone: prefs?.timezone ?? null,
	});
	const needsApproval = toolCtx.needsApproval;

	// The same request builder as the send path (chat/upstream-request.ts), so a
	// resumed turn sends what the send path would have: same system prompt, same
	// tools[] (with this turn's searched-up tools promoted), same parameters and
	// canvas tail. Re-walks the branch each call to pick up new tool results.
	const resolveMediaDataUrl = cachedMediaResolver((mediaId) => mediaIdToDataUrl(mediaId, userId));
	const buildRequestBody = ({
		activatedToolNames = [],
	}: { activatedToolNames?: string[] } = {}): Promise<ChatCompletionRequest> =>
		buildUpstreamRequest({
			conversationId: params.id,
			userId,
			upstreamModelId: parsed.upstreamId,
			branch: walkActiveBranch(params.id, { columns: 'serialization' }),
			systemPrompt: toolCtx.systemPrompt,
			baseToolDefs: toolCtx.toolDefs,
			activatedToolNames,
			parameters: meta.parameters,
			disabledFeatures,
			supportsTools,
			resolveMediaDataUrl,
		});

	const initialRequestBody = await buildRequestBody();

	// The relay's StreamStartEvent carries a user-message snapshot. The
	// resume isn't producing a new user message — the chat page already
	// rendered the prior turn — so we send the last user message in the
	// branch as a no-op placeholder; the client ignores it on resume.
	const updatedBranch = walkActiveBranch(params.id, { columns: 'serialization' });
	const lastUserMessage = [...updatedBranch].reverse().find((m) => m.role === 'user');
	if (!lastUserMessage) error(500, 'No user message anchor for resume');

	// CRITICAL: parent the resumed assistant message to the current
	// active_leaf (the just-completed tool result), not to the user
	// message. Without this override, every resume creates a sibling of
	// the prior assistant turn and the conversation forks once per
	// approval cycle. Falls back to the last message on the branch if
	// active_leaf somehow drifted.
	const initialParentMessageId =
		meta.activeLeafMessageId ?? updatedBranch[updatedBranch.length - 1]?.id ?? lastUserMessage.id;

	// The same model fields the send path registers with: in-flight readers (the
	// conversation list's generating marker, the endpoint view) describe a
	// resumed turn by them, and an entry without them read as an unknown model.
	const inFlight = registerInFlight(params.id, endpoint, undefined, meta.modelKind, meta.modelId);

	const stream = await startStreamingRelay({
		conversationId: params.id,
		userId,
		conversationTitle: meta.title,
		modelKind: meta.modelKind,
		endpoint,
		providerQuirk: endpoint.providerQuirk,
		requestBody: initialRequestBody,
		userMessage: lastUserMessage,
		storedModelId: meta.modelId,
		abortSignal: inFlight.controller.signal,
		inFlight,
		// Free the registry entry when the generation settles, ahead of the
		// relay's post-`done` title race — same reasoning as the send path, and
		// the resumed turn is just as likely to be one the user walked away from.
		// Identity-guarded, so onComplete's later call is a no-op.
		onGenerationSettled: () => clearInFlight(params.id, inFlight),
		onComplete: () => clearInFlight(params.id, inFlight),
		needsApproval,
		// Carry the same enabled-but-down MCP notice the send path emits — the
		// condition persists across an approval resume, so the resumed turn's
		// bubble must re-show it (the client cleared it at the turn boundary).
		...(toolCtx.unavailableMcpServers.length
			? { unavailableMcpServers: toolCtx.unavailableMcpServers }
			: {}),
		disabledFeatures,
		maxToolLoopIterations: getMaxToolLoopIterations(),
		rebuildRequestBody: buildRequestBody,
		initialParentMessageId,
	});

	return sseResponse(stream);
};

interface FoundPending {
	toolMsg: ChatMessage;
	resultPart: Extract<MessagePart, { type: 'tool_result' }>;
	toolCallPart: Extract<MessagePart, { type: 'tool_call' }>;
}

function findPending(branch: ChatMessage[], toolCallId: string): FoundPending | null {
	const toolMsgIdx = branch.findIndex(
		(m) =>
			m.role === 'tool' &&
			m.parts.some(
				(p) =>
					isToolResultPart(p) && p.toolCallId === toolCallId && p.status === 'pending_approval',
			),
	);
	if (toolMsgIdx < 0) return null;
	const toolMsg = branch[toolMsgIdx];
	const resultPart = toolMsg.parts.find(
		(p): p is Extract<MessagePart, { type: 'tool_result' }> =>
			isToolResultPart(p) && p.toolCallId === toolCallId,
	);
	if (!resultPart) return null;
	// Walk backwards from the tool msg to find the assistant that emitted
	// this tool_call.
	for (let i = toolMsgIdx - 1; i >= 0; i--) {
		const candidate = branch[i].parts.find(
			(p): p is Extract<MessagePart, { type: 'tool_call' }> =>
				isToolCallPart(p) && p.toolCallId === toolCallId,
		);
		if (candidate) {
			return { toolMsg, resultPart, toolCallPart: candidate };
		}
	}
	return null;
}
