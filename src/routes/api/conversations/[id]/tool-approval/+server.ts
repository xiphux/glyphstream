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
import { parseJsonBody } from '$lib/server/http';
import { getConversationMeta } from '$lib/server/db/queries/conversations';
import { walkActiveBranch, updateMessageParts } from '$lib/server/db/queries/messages';
import { getEndpoint } from '$lib/server/endpoints/registry';
import { listAllModels } from '$lib/server/endpoints/list-models';
import { serializeBranchForUpstream } from '$lib/server/endpoints/serialize-upstream';
import { parseModelId } from '$lib/server/endpoints/model-id';
import { openaiToolDefinitions } from '$lib/server/tools';
import { awaitMcpReady } from '$lib/server/mcp/bootstrap';
import {
	composePersonaSystemPrompt,
	getUserPreferences,
	setUserPreferences
} from '$lib/server/db/queries/user-preferences';
import { listMemoriesForUser } from '$lib/server/db/queries/memories';
import { get as getTool } from '$lib/server/tools/registry';
import { clearInFlight, registerInFlight } from '$lib/server/streaming/in-flight';
import { startStreamingRelay } from '$lib/server/streaming/relay';
import { mediaIdToDataUrl } from '$lib/server/media/data-url';
import type { ChatCompletionRequest } from '$lib/server/endpoints/client';
import type { ChatMessage, MessagePart } from '$lib/types/api';
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

export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Sign in to continue.');
	const userId = locals.user.id;

	const body = await parseJsonBody<ApprovalBody>(request);
	if (!body || !Array.isArray(body.decisions) || body.decisions.length === 0) {
		throw error(400, "Expected { decisions: [{ toolCallId, action }, ...] }");
	}
	for (const d of body.decisions) {
		if (typeof d.toolCallId !== 'string' || d.toolCallId.length === 0) {
			throw error(400, 'Each decision needs a non-empty toolCallId');
		}
		if (d.action !== 'allow' && d.action !== 'allow_always' && d.action !== 'reject') {
			throw error(400, `Unknown action "${d.action}"`);
		}
	}

	const meta = getConversationMeta(params.id, userId);
	if (!meta) throw error(404, 'Conversation not found');
	const endpoint = getEndpoint(meta.endpointId);
	if (!endpoint) {
		throw error(409, `Endpoint "${meta.endpointId}" is no longer in config.toml`);
	}

	await awaitMcpReady();

	// Snapshot the branch *before* we mutate it so the toolCallId lookups
	// are stable across the decision loop. Apply changes via
	// updateMessageParts — the active-leaf doesn't move because we're
	// rewriting existing rows, not appending.
	const branch = walkActiveBranch(params.id);
	const newlyTrusted: string[] = [];
	let updatedAny = false;

	for (const decision of body.decisions) {
		const found = findPending(branch, decision.toolCallId);
		if (!found) continue;
		const { toolMsg, resultPart, toolCallPart } = found;

		let nextPart: Extract<MessagePart, { type: 'tool_result' }>;
		if (decision.action === 'reject') {
			nextPart = {
				type: 'tool_result',
				toolCallId: resultPart.toolCallId,
				result: JSON.stringify({ error: 'User declined this tool call.' }),
				isError: true
			};
		} else {
			const execution = await runApprovedTool(
				toolCallPart,
				userId,
				params.id,
				request.signal
			);
			nextPart = {
				type: 'tool_result',
				toolCallId: resultPart.toolCallId,
				result: execution.content,
				...(execution.isError ? { isError: true } : {})
			};
			if (decision.action === 'allow_always') newlyTrusted.push(toolCallPart.toolName);
		}

		updateMessageParts(toolMsg.id, params.id, [nextPart]);
		updatedAny = true;
	}

	if (!updatedAny) {
		throw error(409, 'No pending tool calls matched the decisions in this body.');
	}

	// Persist newly-trusted tools before continuing the relay so the
	// needsApproval predicate sees them on the next iteration.
	if (newlyTrusted.length > 0) {
		const existing = getUserPreferences(userId)?.trustedMcpTools ?? [];
		const merged = Array.from(new Set([...existing, ...newlyTrusted]));
		setUserPreferences(userId, { trustedMcpTools: merged });
	}

	const prefs = getUserPreferences(userId);
	let effectiveSystemPrompt: string | null = meta.systemPrompt;
	if (
		effectiveSystemPrompt === null &&
		!meta.disabledFeatures.includes('personalization')
	) {
		const memories = listMemoriesForUser(userId);
		if (prefs) effectiveSystemPrompt = composePersonaSystemPrompt(prefs, memories);
	}

	const parsed = parseModelId(meta.modelId);
	if (!parsed) throw error(500, `Conversation modelId "${meta.modelId}" is malformed`);

	const allModels = await listAllModels();
	const modelEntry = allModels.find(
		(m) => m.endpointId === parsed.endpointId && m.upstreamId === parsed.upstreamId
	);
	const supportsTools = modelEntry?.supportsTools ?? endpoint.supportsTools ?? false;
	if (!supportsTools) {
		// Should be impossible — we only got here because a turn earlier
		// reached pending_approval, which means tools were enabled. Defend
		// loudly.
		throw error(500, 'Tools no longer enabled for this conversation; cannot resume.');
	}

	const toolDefs = openaiToolDefinitions({ excludeCategories: meta.disabledFeatures });
	const trustedSet = new Set(prefs?.trustedMcpTools ?? []);
	const needsApproval = (toolName: string) =>
		toolName.startsWith('mcp__') && !trustedSet.has(toolName);

	const buildRequestBody = async (): Promise<ChatCompletionRequest> => {
		const nextBranch = walkActiveBranch(params.id);
		const nextMessages = await serializeBranchForUpstream(
			nextBranch,
			(mediaId) => mediaIdToDataUrl(mediaId, userId),
			effectiveSystemPrompt
		);
		const requestBody: ChatCompletionRequest = {
			model: parsed.upstreamId,
			messages: nextMessages,
			stream: true,
			stream_options: { include_usage: true }
		};
		if (toolDefs.length > 0) {
			requestBody.tools = toolDefs;
			requestBody.tool_choice = 'auto';
		}
		if (meta.parameters?.temperature !== undefined) {
			requestBody.temperature = meta.parameters.temperature;
		}
		if (meta.parameters?.top_p !== undefined) {
			requestBody.top_p = meta.parameters.top_p;
		}
		if (meta.parameters?.max_tokens !== undefined) {
			requestBody.max_tokens = meta.parameters.max_tokens;
		}
		return requestBody;
	};

	const initialRequestBody = await buildRequestBody();

	// The relay's StreamStartEvent carries a user-message snapshot. The
	// resume isn't producing a new user message — the chat page already
	// rendered the prior turn — so we send the last user message in the
	// branch as a no-op placeholder; the client ignores it on resume.
	const updatedBranch = walkActiveBranch(params.id);
	const lastUserMessage = [...updatedBranch].reverse().find((m) => m.role === 'user');
	if (!lastUserMessage) throw error(500, 'No user message anchor for resume');

	// CRITICAL: parent the resumed assistant message to the current
	// active_leaf (the just-completed tool result), not to the user
	// message. Without this override, every resume creates a sibling of
	// the prior assistant turn and the conversation forks once per
	// approval cycle. Falls back to the last message on the branch if
	// active_leaf somehow drifted.
	const initialParentMessageId =
		meta.activeLeafMessageId ?? updatedBranch[updatedBranch.length - 1]?.id ?? lastUserMessage.id;

	const inFlight = registerInFlight(params.id, endpoint);

	const stream = await startStreamingRelay({
		conversationId: params.id,
		userId,
		conversationTitle: meta.title,
		modelKind: meta.modelKind,
		endpoint,
		providerQuirk: endpoint.providerQuirk,
		requestBody: initialRequestBody,
		userMessage: lastUserMessage as ChatMessage,
		storedModelId: meta.modelId,
		abortSignal: inFlight.controller.signal,
		onComplete: () => clearInFlight(params.id, inFlight),
		needsApproval,
		rebuildRequestBody: buildRequestBody,
		initialParentMessageId
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache, no-store, no-transform',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no'
		}
	});
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
					isToolResultPart(p) &&
					p.toolCallId === toolCallId &&
					p.status === 'pending_approval'
			)
	);
	if (toolMsgIdx < 0) return null;
	const toolMsg = branch[toolMsgIdx];
	const resultPart = toolMsg.parts.find(
		(p): p is Extract<MessagePart, { type: 'tool_result' }> =>
			isToolResultPart(p) && p.toolCallId === toolCallId
	);
	if (!resultPart) return null;
	// Walk backwards from the tool msg to find the assistant that emitted
	// this tool_call.
	for (let i = toolMsgIdx - 1; i >= 0; i--) {
		const candidate = branch[i].parts.find(
			(p): p is Extract<MessagePart, { type: 'tool_call' }> =>
				isToolCallPart(p) && p.toolCallId === toolCallId
		);
		if (candidate) {
			return { toolMsg, resultPart, toolCallPart: candidate };
		}
	}
	return null;
}

async function runApprovedTool(
	toolCallPart: Extract<MessagePart, { type: 'tool_call' }>,
	userId: string,
	conversationId: string,
	signal: AbortSignal
): Promise<{ content: string; isError: boolean }> {
	const tool = getTool(toolCallPart.toolName);
	if (!tool) {
		return {
			content: JSON.stringify({ error: `Unknown tool: ${toolCallPart.toolName}` }),
			isError: true
		};
	}
	let args: unknown = {};
	if (toolCallPart.arguments.length > 0) {
		try {
			args = JSON.parse(toolCallPart.arguments);
		} catch (e) {
			return {
				content: JSON.stringify({
					error: `Tool arguments did not parse as JSON: ${e instanceof Error ? e.message : String(e)}`
				}),
				isError: true
			};
		}
	}
	try {
		const execution = await Promise.resolve(
			tool.execute(args, { userId, conversationId, signal })
		);
		return { content: execution.content, isError: execution.isError === true };
	} catch (e) {
		return {
			content: JSON.stringify({
				error: `Tool "${toolCallPart.toolName}" threw: ${e instanceof Error ? e.message : String(e)}`
			}),
			isError: true
		};
	}
}
