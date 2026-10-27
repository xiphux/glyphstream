/**
 * Start a chat turn: assemble the system prompt, tools and upstream request
 * from the conversation's active branch, then hand them to the streaming relay.
 *
 * Shared by the three things that start one — a message send, a tool-approval
 * resume, and a scheduled task — so the per-request surface (prompt, tools[],
 * the approval gate, the request builder) can't drift between them. It used to
 * be written out twice, once per route handler, kept in step by comments.
 *
 * Takes no request: everything is keyed by `userId` and `conversationId`, which
 * is what lets the scheduled-task runner start a turn with nobody connected.
 * Admission (ownership, caps, model resolution, the user message itself) and
 * in-flight registration stay with the caller, which knows what kind of turn
 * this is.
 */
import { error } from '@sveltejs/kit';
import { upstreamBranch } from '#lib/chat-compaction.js';
import type { ChatMessage, FeatureCategory, ScheduledToolPolicy } from '#lib/types/api.js';
import type { ChatCompletionRequest } from '../endpoints/client';
import type { LoadedEndpoint } from '../endpoints/config';
import { getMaxToolLoopIterations } from '../endpoints/config';
import { listAllModels } from '../endpoints/list-models';
import { isModelVisiblePart } from '../endpoints/serialize-upstream';
import type { getConversationMeta } from '../db/queries/conversations';
import { walkActiveBranch } from '../db/queries/messages';
import { getUserPreferences } from '../db/queries/user-preferences';
import { mediaIdToDataUrl } from '../media/data-url';
import { scheduleCheckInFromReply } from '../check-ins/schedule';
import type { InFlightEntry } from '../streaming/in-flight';
import { startStreamingRelay, type RelayParams } from '../streaming/relay';
import { composePersonaPrompt } from './persona-context';
import {
	synthesizeSkillActivations,
	type SyntheticActivationEvent,
} from './synthesize-skill-activation';
import { buildChatToolContext } from './tool-context';
import { buildUpstreamRequest, cachedMediaResolver } from './upstream-request';

export type TurnConversation = NonNullable<ReturnType<typeof getConversationMeta>>;

/** Relay options that describe the kind of turn, passed through untouched. */
type RelayPassthrough = Pick<
	RelayParams,
	| 'advanceActiveLeaf'
	| 'fanoutIndex'
	| 'suppressTitleTask'
	| 'suppressNotify'
	| 'onGenerationSettled'
	| 'onComplete'
	| 'onOutcome'
	| 'initialParentMessageId'
	| 'slotPurpose'
	| 'slotPriority'
>;

export interface StartChatTurnInput extends RelayPassthrough {
	conversationId: string;
	userId: string;
	/** The conversation, with any per-turn model override already applied. */
	meta: TurnConversation;
	endpoint: LoadedEndpoint;
	/** `meta.modelId`, parsed. */
	model: { endpointId: string; upstreamId: string };
	disabledFeatures: readonly FeatureCategory[];
	inFlight: InFlightEntry;
	/** The user message the turn answers (for a resume, the last one on the branch). */
	userMessage: ChatMessage;
	/** False when the turn may not use tools whatever the model supports (a
	 *  fan-out branch runs a single iteration, so a tool call would go unanswered). */
	allowTools: boolean;
	/** Fail rather than run without tools (a resume only exists because tools ran). */
	requireTools?: boolean;
	/** `/skill-name` activations to synthesize before the model generates. */
	activatedSkillNames?: string[];
	/** A scheduled task's tool policy, for its runs (see `ChatToolContextInput`). */
	toolPolicy?: ScheduledToolPolicy;
}

export async function startChatTurn(
	input: StartChatTurnInput,
): Promise<ReadableStream<Uint8Array>> {
	const { conversationId, userId, meta, endpoint, disabledFeatures, inFlight } = input;

	// System prompt precedence: the conversation's snapshotted prompt (a custom
	// model preset or an explicit one at create time), else the persona + saved
	// memories composed from current prefs, gated by `personalization`. Both are
	// re-derived per turn so edits reach existing chats on the next send. Prefs
	// are read regardless: every turn needs trustedMcpTools for the approval gate.
	const prefs = getUserPreferences(userId);
	const baseSystemPrompt =
		meta.systemPrompt ?? composePersonaPrompt(prefs, userId, disabledFeatures);

	// Tool support is resolved before the tool context because skills inject both
	// a catalog into the prompt and the activation tools, and a catalog with no
	// activation tool would be misleading. Prefers the per-model upstream signal,
	// falling back to the endpoint config.
	const modelEntry = (await listAllModels()).find(
		(m) => m.endpointId === input.model.endpointId && m.upstreamId === input.model.upstreamId,
	);
	const modelSupportsTools = modelEntry?.supportsTools ?? endpoint.supportsTools ?? false;
	if (input.requireTools && !modelSupportsTools) {
		// Should be impossible: a resume only exists because a turn reached
		// pending_approval, which means tools were enabled. Defend loudly.
		error(500, 'Tools no longer enabled for this conversation; cannot resume.');
	}
	const supportsTools = modelSupportsTools && input.allowTools;

	// Explicit skill activation (the /skill-name composer command): synthesize a
	// real activate_skill exchange BEFORE the model generates, so it receives the
	// skill body exactly as a model-driven activation would. The appends advance
	// the active leaf, so the branch walk below includes them, and the synthetic
	// tool result becomes the relay's parent. Server-authoritative: only with tool
	// support, `skills` enabled, and names that resolve to enabled skills.
	let synthLeafId: string | undefined;
	let preActivatedToolEvents: SyntheticActivationEvent[] = [];
	if (
		supportsTools &&
		!disabledFeatures.includes('skills') &&
		Array.isArray(input.activatedSkillNames) &&
		input.activatedSkillNames.length > 0
	) {
		const synth = await synthesizeSkillActivations({
			conversationId,
			userId,
			parentMessageId: input.userMessage.id,
			names: input.activatedSkillNames,
			disabledFeatures,
			signal: inFlight.controller.signal,
		});
		synthLeafId = synth?.leafMessageId;
		preActivatedToolEvents = synth?.events ?? [];
	}

	const branch = walkActiveBranch(conversationId, { columns: 'serialization' });

	// The system prompt + tool list + approval gate for this branch. The skills
	// catalog and deferred-tool hint fold into the prompt here, so the initial
	// request and every per-iteration rebuild carry them.
	const toolCtx = await buildChatToolContext({
		userId,
		disabledFeatures,
		supportsTools,
		baseSystemPrompt,
		replyStyle: meta.replyStyle,
		branch,
		trustedMcpTools: prefs?.trustedMcpTools ?? [],
		timeZone: prefs?.timezone ?? null,
		toolPolicy: input.toolPolicy,
	});

	// Per-turn data-URL cache. Image bytes are immutable for the life of the
	// conversation, so each media id is read and base64-encoded at most once per
	// turn rather than on every tool-loop rebuild.
	const resolveMediaDataUrl = cachedMediaResolver((mediaId) => mediaIdToDataUrl(mediaId, userId));

	// Warm the cache concurrently, so the order-preserving serialize awaits reads
	// already in flight rather than resolving them one at a time ahead of the
	// first upstream byte. Walks `upstreamBranch(branch)` and skips parts the
	// model never sees (a display-only avatar portrait), so nothing in the
	// summarized-away prefix is read and pinned for nothing. The `.catch` is only
	// on the fire-and-forget reference; the cached promise keeps its rejection.
	for (const m of upstreamBranch(branch)) {
		for (const p of m.parts) {
			if (p.type === 'image' && isModelVisiblePart(p)) {
				void resolveMediaDataUrl(p.mediaId).catch(() => {});
			}
		}
	}

	// Rebuilt between tool-loop iterations: the active leaf has advanced to the
	// latest tool result, so re-walking the branch picks up the tool calls and
	// results, and tools the model searched up this turn are promoted into
	// tools[] (appended to the first request's, see turnStartTools).
	const requestFor = (
		branchNow: ChatMessage[],
		activatedToolNames: string[] = [],
		turnStartTools?: ChatCompletionRequest['tools'],
	): Promise<ChatCompletionRequest> =>
		buildUpstreamRequest({
			conversationId,
			userId,
			upstreamModelId: input.model.upstreamId,
			branch: branchNow,
			systemPrompt: toolCtx.systemPrompt,
			baseToolDefs: toolCtx.toolDefs,
			activatedToolNames,
			turnStartTools,
			parameters: meta.parameters,
			disabledFeatures,
			supportsTools,
			resolveMediaDataUrl,
		});
	const requestBody = await requestFor(branch);
	const rebuildRequestBody = ({
		activatedToolNames,
	}: {
		activatedToolNames: string[];
	}): Promise<ChatCompletionRequest> =>
		requestFor(
			walkActiveBranch(conversationId, { columns: 'serialization' }),
			activatedToolNames,
			requestBody.tools ?? [],
		);

	return startStreamingRelay({
		conversationId,
		userId,
		conversationTitle: meta.title,
		modelKind: meta.modelKind,
		endpoint,
		providerQuirk: endpoint.providerQuirk,
		requestBody,
		userMessage: input.userMessage,
		storedModelId: meta.modelId,
		abortSignal: inFlight.controller.signal,
		inFlight,
		advanceActiveLeaf: input.advanceActiveLeaf,
		fanoutIndex: input.fanoutIndex,
		suppressTitleTask: input.suppressTitleTask,
		suppressNotify: input.suppressNotify,
		onGenerationSettled: input.onGenerationSettled,
		onComplete: input.onComplete,
		onOutcome: input.onOutcome,
		// A texting reply that lands on the thread replaces the conversation's
		// check-in with whatever it sets. Not a comparison's branch, which isn't
		// on the thread until it's picked.
		...(meta.replyStyle === 'texting' && input.advanceActiveLeaf !== false
			? {
					onFinalReply: (reply: ChatMessage) => {
						scheduleCheckInFromReply(conversationId, userId, reply.id);
					},
				}
			: {}),
		slotPurpose: input.slotPurpose,
		slotPriority: input.slotPriority,
		// A synthesized skill activation parents the model's first response off
		// the synthetic tool result (the same seam a resume uses), and is replayed
		// as live SSE so its block renders in-flight.
		initialParentMessageId: synthLeafId ?? input.initialParentMessageId,
		...(preActivatedToolEvents.length ? { preActivatedToolEvents } : {}),
		// Built-in and user-trusted MCP tools execute inline; untrusted MCP tools
		// halt the turn with an inline approval prompt.
		needsApproval: toolCtx.needsApproval,
		isToolPermitted: toolCtx.isToolPermitted,
		// Per-user MCP servers enabled here but down, for the inline "tools
		// skipped" notice.
		...(toolCtx.unavailableMcpServers.length
			? { unavailableMcpServers: toolCtx.unavailableMcpServers }
			: {}),
		// Threaded into each tool's ToolContext, for tools whose behavior depends
		// on a category other than their own (run_python's network shim on 'web').
		disabledFeatures,
		maxToolLoopIterations: getMaxToolLoopIterations(),
		// No tools, no loop: the single-iteration path is explicit.
		...(toolCtx.toolDefs.length > 0 ? { rebuildRequestBody } : {}),
	});
}
