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
import { parseModelId } from '#lib/server/endpoints/model-id.js';
import { awaitMcpReady } from '#lib/server/mcp/bootstrap.js';
import { resolveDisabledFeatures } from '#lib/server/chat/private-seal.js';
import { startChatTurn } from '#lib/server/chat/start-turn.js';
import {
	getScheduledTask,
	setScheduledTaskToolPolicy,
} from '#lib/server/db/queries/scheduled-tasks.js';
import { scheduledPolicyForResume, settleResumedRun } from '#lib/server/scheduled/runner.js';
import { toolPermitter } from '#lib/server/scheduled/tool-policy.js';
import type { TurnOutcome } from '#lib/server/streaming/relay.js';
import { getUserPreferences, setUserPreferences } from '#lib/server/db/queries/user-preferences.js';
import { executeOneToolCall } from '#lib/server/streaming/tool-execution.js';
import { clearInFlight, registerInFlight } from '#lib/server/streaming/in-flight.js';
import { sseResponse } from '#lib/server/streaming/sse-transport.js';
import type { ChatMessage, MessagePart } from '#lib/types/api.js';
import type { RequestHandler } from './$types';

interface ApprovalDecision {
	toolCallId: string;
	action: ApprovalAction;
}

/** `allow_schedule` / `deny_schedule` are a scheduled run's: allow (or reject)
 *  this call AND remember it in the schedule's tool policy, so the next run
 *  neither asks nor is offered it. */
const ACTIONS = ['allow', 'allow_always', 'reject', 'allow_schedule', 'deny_schedule'] as const;
type ApprovalAction = (typeof ACTIONS)[number];

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
		if (!(ACTIONS as readonly string[]).includes(d.action)) {
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

	// A scheduled run that paused for approval resumes under its schedule's tool
	// policy (read fresh, so an "allow for this schedule" just made applies), and
	// its run row is settled when the resumed turn ends.
	let scheduleTask = meta.scheduleId ? getScheduledTask(meta.scheduleId, userId) : null;
	let scheduled = scheduledPolicyForResume(params.id, userId, meta.scheduleId, scheduleTask);
	const isToolPermitted = scheduled ? toolPermitter(scheduled.policy) : undefined;
	if (
		!scheduleTask &&
		body.decisions.some((d) => d.action === 'allow_schedule' || d.action === 'deny_schedule')
	) {
		error(400, 'This conversation is not a scheduled task’s run');
	}

	// Apply changes via updateMessageParts — the active-leaf doesn't move
	// because we're rewriting existing rows, not appending.
	const newlyTrusted: string[] = [];
	const scheduleAllowed: string[] = [];
	const scheduleDenied: string[] = [];
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
			if (decision.action === 'reject' || decision.action === 'deny_schedule') {
				if (decision.action === 'deny_schedule') scheduleDenied.push(toolCallPart.toolName);
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
				isToolPermitted,
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
			if (decision.action === 'allow_schedule') scheduleAllowed.push(toolCallPart.toolName);
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
	// Same for the schedule's own policy, and re-read it so the resumed turn
	// runs under the policy as it now stands.
	if (scheduleTask && (scheduleAllowed.length > 0 || scheduleDenied.length > 0)) {
		const p = scheduleTask.toolPolicy;
		const denied = new Set(scheduleDenied);
		const allowed = new Set(scheduleAllowed);
		setScheduledTaskToolPolicy(scheduleTask.id, userId, {
			...p,
			allowed: [...new Set([...p.allowed, ...allowed])].filter((n) => !denied.has(n)),
			ask: p.ask.filter((n) => !denied.has(n) && !allowed.has(n)),
		});
		scheduleTask = getScheduledTask(scheduleTask.id, userId);
		scheduled = scheduledPolicyForResume(params.id, userId, meta.scheduleId, scheduleTask);
	}

	const parsed = parseModelId(meta.modelId);
	if (!parsed) error(500, `Conversation modelId "${meta.modelId}" is malformed`);

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

	// Assembled exactly as the send path does (shared startChatTurn), seeded from
	// the post-decision branch, so a turn that activated a skill / searched up a
	// deferred tool / called a per-user MCP tool before pausing keeps all of them
	// on resume — without this the resumed turn would silently lose them.
	let stream: ReadableStream<Uint8Array>;
	try {
		stream = await startChatTurn({
			conversationId: params.id,
			userId,
			meta,
			endpoint,
			model: parsed,
			disabledFeatures,
			inFlight,
			userMessage: lastUserMessage,
			allowTools: true,
			requireTools: true,
			initialParentMessageId,
			toolPolicy: scheduled?.policy,
			...(scheduled && scheduleTask
				? {
						onOutcome: (outcome: TurnOutcome) =>
							settleResumedRun(scheduleTask, userId, scheduled.runId, params.id, outcome),
					}
				: {}),
			// Free the registry entry when the generation settles, ahead of the
			// relay's post-`done` title race — same reasoning as the send path, and
			// the resumed turn is just as likely to be one the user walked away
			// from. Identity-guarded, so onComplete's later call is a no-op.
			onGenerationSettled: () => clearInFlight(params.id, inFlight),
			onComplete: () => clearInFlight(params.id, inFlight),
		});
	} catch (e) {
		clearInFlight(params.id, inFlight);
		throw e;
	}

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
