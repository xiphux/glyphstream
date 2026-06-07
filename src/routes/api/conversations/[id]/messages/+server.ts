import type { Buffer } from 'node:buffer';
import { error, json } from '@sveltejs/kit';
import { requireFound, requireUser } from '$lib/server/auth/guard';
import { parseJsonBody } from '$lib/server/http';
import { getConversationMeta, updateConversationModel } from '$lib/server/db/queries/conversations';
import { linkMessageMedia } from '$lib/server/db/queries/media';
import {
	appendMessage,
	findUserMessageAncestor,
	getMessage,
	setActiveLeafMessageId,
	walkActiveBranch,
} from '$lib/server/db/queries/messages';
import { createUserMessage } from '$lib/server/messages/create-user-message';
import {
	chatCompletionSync,
	formatUpstreamError,
	UpstreamError,
	type ChatCompletionRequest,
} from '$lib/server/endpoints/client';
import { getEndpoint } from '$lib/server/endpoints/registry';
import { generateId } from '$lib/server/util/id';
import { listAllModels } from '$lib/server/endpoints/list-models';
import { serializeBranchForUpstream } from '$lib/server/endpoints/serialize-upstream';
import { parseModelId } from '$lib/server/endpoints/model-id';
import { openaiToolDefinitions } from '$lib/server/tools';
import { awaitMcpReady } from '$lib/server/mcp/bootstrap';
import {
	composePersonaSystemPrompt,
	getUserPreferences,
} from '$lib/server/db/queries/user-preferences';
import { listMemoriesForUser } from '$lib/server/db/queries/memories';
import { logLevel } from '$lib/server/env';
import { renderMarkdown } from '$lib/server/markdown/render';
import { loadMediaBytes, mediaIdToDataUrl } from '$lib/server/media/data-url';
import { notifyConversationComplete } from '$lib/server/push/notify';
import { clearInFlight, registerInFlight } from '$lib/server/streaming/in-flight';
import { startStreamingRelay } from '$lib/server/streaming/relay';
import { startImageRelay } from '$lib/server/streaming/image-relay';
import { startVideoRelay } from '$lib/server/streaming/video-relay';
import { raceTitle, startTitleTaskIfFirstExchange } from '$lib/server/tasks/title-task-runner';

const TITLE_DELIVERY_BUDGET_MS = 5000;

const DEBUG = logLevel() === 'debug';
import { isModelKind } from '$lib/types/api';
import type { ChatMessage, SendMessageRequest, SendMessageResponse } from '$lib/types/api';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, params, request, url }) => {
	requireUser(locals);

	const body = await parseJsonBody<SendMessageRequest>(request);
	const isRetry = typeof body.regenerateFromMessageId === 'string' && body.regenerateFromMessageId;
	// One branch of a multi-model fan-out: the shared user message already
	// exists (created by /prepare) and is referenced via parentMessageId. The
	// branch derives its prompt from that message, like retry.
	const isFanout = body.fanoutBranch === true;
	const text = body.text?.trim() ?? '';
	const attachedMediaIds = Array.isArray(body.attachedMediaIds)
		? body.attachedMediaIds.filter((s): s is string => typeof s === 'string')
		: [];
	if (!isRetry && !isFanout && !text && attachedMediaIds.length === 0) {
		throw error(400, "'text' or 'attachedMediaIds' is required");
	}
	if (isFanout && isRetry) {
		throw error(400, 'fanoutBranch and regenerateFromMessageId are mutually exclusive');
	}

	const meta = requireFound(
		getConversationMeta(params.id, locals.user.id),
		'Conversation not found',
	);

	// Per-turn model override: when the client supplies a `modelId` that
	// differs from what the conversation row currently stores, validate it
	// and rewrite the row's routing fields BEFORE we resolve the endpoint
	// for dispatch. Crucially, this runs prior to the endpoint check
	// below — so for an imported OWUI chat (whose stored `endpoint_id`
	// doesn't resolve to a real endpoint) the user picking any real model
	// here unblocks the send without a separate "fix this chat" flow.
	// `system_prompt`, `parameters_json`, and `custom_model_id` stay put.
	if (typeof body.modelId === 'string' && body.modelId && body.modelId !== meta.modelId) {
		const newParsed = parseModelId(body.modelId);
		if (!newParsed) {
			throw error(400, `modelId "${body.modelId}" is malformed`);
		}
		const newEndpoint = getEndpoint(newParsed.endpointId);
		if (!newEndpoint) {
			throw error(400, `Endpoint "${newParsed.endpointId}" is not configured`);
		}
		const newKind = isModelKind(body.modelKind) ? body.modelKind : meta.modelKind;
		// A fan-out branch's model is TRANSIENT: skip the DB write so N
		// concurrent branches don't clobber the conversation's stored default
		// (whichever finished last would win). The branch's model is still
		// applied to this dispatch via the in-memory `meta` mutation below and
		// recorded per-message through `modelUsed`.
		if (!isFanout) {
			updateConversationModel(params.id, locals.user.id, {
				endpointId: newParsed.endpointId,
				modelId: body.modelId,
				modelKind: newKind,
			});
		}
		meta.endpointId = newParsed.endpointId;
		meta.modelId = body.modelId;
		meta.modelKind = newKind;
	}

	// At this point either (a) the body carried a valid override and we
	// rewrote meta above, or (b) the conversation's stored model resolves
	// natively. Otherwise the conversation has an unresolvable model
	// (imported OWUI chat with no override picked yet, or the configured
	// endpoint was removed from config.toml) — return a 400 with an
	// actionable message rather than a 500 so the UI can surface it.
	const parsed = parseModelId(meta.modelId);
	if (!parsed || !getEndpoint(parsed.endpointId)) {
		throw error(
			400,
			'This conversation has no valid model. Pick one from the model picker before sending.',
		);
	}
	const endpoint = getEndpoint(parsed.endpointId)!;

	// `userMessage` is the anchor that the assistant message hangs off of.
	// For a regular send it's a freshly-persisted row; for a retry it's
	// the existing user message that prompted the assistant turn we're
	// regenerating. Either way the dispatcher uses it as the parent for
	// the new assistant message.
	let userMessage;
	if (isFanout) {
		// The shared user message was created by /prepare; this branch just
		// references it as the parent for its sibling assistant response.
		const parentId = body.parentMessageId;
		if (typeof parentId !== 'string' || !parentId) {
			throw error(400, 'fanoutBranch requires parentMessageId (the shared user message)');
		}
		const parent = getMessage(params.id, parentId);
		if (!parent) throw error(404, `Message "${parentId}" not found`);
		if (parent.role !== 'user') {
			throw error(400, 'fanoutBranch parentMessageId must reference a user message');
		}
		userMessage = parent;
		// Deliberately do NOT setActiveLeafMessageId here. /prepare pinned the
		// leaf at this user message and it must stay there: every concurrent
		// branch serializes the identical history, and the unpicked siblings
		// remain reachable branches until the user selects one.
	} else if (isRetry) {
		const target = getMessage(params.id, body.regenerateFromMessageId!);
		if (!target) throw error(404, `Message "${body.regenerateFromMessageId}" not found`);
		if (target.role !== 'assistant') {
			throw error(400, 'regenerateFromMessageId must reference an assistant message');
		}
		if (!target.parentMessageId) {
			throw error(400, 'Cannot retry a root message');
		}
		// Multi-iteration tool turns produce a chain like
		//   user → assistant_0 (tool_call) → tool_0 → assistant_1 (final).
		// Retry on assistant_1 walks UP past assistant/tool ancestors to
		// find the user message that started the turn — that's where the
		// new (regenerated) assistant attaches as a sibling of
		// assistant_0. Retry semantics is "do the whole turn over," not
		// "just regenerate the final text"; without the walk, a retry on
		// the last assistant of a multi-iteration turn errored with "no
		// user-message parent" because the immediate parent was a tool.
		userMessage = findUserMessageAncestor(params.id, target.id) ?? undefined;
		if (!userMessage) {
			throw error(400, 'Retry target has no user-message ancestor');
		}
		// Re-anchor the active branch at the user message — walks from
		// here build the upstream request from history-up-to-the-retry-
		// point. The new assistant turn (and any of its tool messages)
		// becomes a sibling subtree of the chain being retried.
		setActiveLeafMessageId(params.id, userMessage.id);
	} else {
		userMessage = createUserMessage({
			conversationId: params.id,
			userId: locals.user.id,
			text,
			attachedMediaIds,
			editedMessageId: body.editedMessageId,
			parentMessageId: body.parentMessageId,
			activeLeafMessageId: meta.activeLeafMessageId ?? null,
			existingTitle: meta.title,
		});
	}

	if (DEBUG) {
		console.debug(
			`[messages] dispatch conversation=${params.id} modelKind=${meta.modelKind} modelId=${meta.modelId} stream=${url.searchParams.get('stream') === '1'}${isRetry ? ' retry=1' : ''}`,
		);
	}

	// Derive the prompt + image refs from the canonical user message
	// rather than the request body — keeps retry working without special-
	// casing every dispatcher branch (the parent user message has both
	// the original prompt and the original attached image refs in its
	// parts).
	const promptText = userMessage.parts
		.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
		.map((p) => p.text)
		.join('');
	let dispatchMediaIds = userMessage.parts
		.filter((p): p is { type: 'image'; mediaId: string } => p.type === 'image')
		.map((p) => p.mediaId);
	// Split-attachments: a fan-out branch may restrict itself to a subset of the
	// shared user message's images (typically one), so N attached images fan out
	// into N independent edits / animations. Only ids actually attached to the
	// parent are honored — a branch can't smuggle in arbitrary media.
	if (isFanout && Array.isArray(body.inputMediaIds)) {
		const attached = new Set(dispatchMediaIds);
		dispatchMediaIds = body.inputMediaIds.filter(
			(m): m is string => typeof m === 'string' && attached.has(m),
		);
	}
	// Provenance for an image-input generation (i2i edit / i2v): record the
	// (first) source image so the split grid can label each result by its input
	// and a reload can rebuild that pairing. Null for text-to-image/video.
	const sourceMediaId = dispatchMediaIds[0] ?? null;

	// Register this generation so POST /api/conversations/:id/cancel can
	// reach the upstream call and abort it. We pass the signal down through
	// every code path that talks to upstream. Fan-out branches each get a
	// unique key so they coexist in the registry instead of cancelling one
	// another; a plain send uses the default single-slot key.
	// Regenerate (re-roll in place): the sibling this branch replaces. Recorded
	// on the in-flight entry so recovery shadows the old-but-not-yet-deleted
	// sibling while the re-roll runs. Display-only (it never deletes anything —
	// the client does that once the new one lands), so a bad value would at most
	// hide one of your own siblings from your recovered grid.
	const replacesMessageId =
		isFanout && typeof body.replacesMessageId === 'string' ? body.replacesMessageId : null;
	const inFlight = registerInFlight(
		params.id,
		endpoint,
		isFanout ? generateId() : undefined,
		meta.modelKind,
		meta.modelId,
		replacesMessageId,
	);

	// --- image-kind models: prompt → image; no chat history -------------------
	// Always streamed (SSE) via startImageRelay — single send and fan-out branch
	// alike (the client requests ?stream=1 for image everywhere). The relay holds
	// the per-endpoint concurrency slot and emits `queued` while waiting →
	// `start` on acquire → `done` with the persisted image, so a busy endpoint
	// surfaces a "Queued…" state + an honest timer instead of a blocking POST.
	if (meta.modelKind === 'image') {
		const stream = startImageRelay({
			conversationId: params.id,
			userId: locals.user.id,
			conversationTitle: meta.title,
			endpoint,
			storedModelId: meta.modelId,
			upstreamModelId: parsed.upstreamId,
			prompt: promptText,
			userMessage: userMessage as ChatMessage,
			dispatchMediaIds,
			sourceMediaId,
			abortSignal: inFlight.controller.signal,
			advanceActiveLeaf: !isFanout,
			suppressTitleTask: isFanout,
			onStarted: () => {
				inFlight.generationStartedAt = Date.now();
			},
			onComplete: () => clearInFlight(params.id, inFlight),
		});
		return new Response(stream, {
			headers: {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache, no-store, no-transform',
				Connection: 'keep-alive',
				'X-Accel-Buffering': 'no',
			},
		});
	}

	if (meta.modelKind === 'video') {
		// I2V: pre-load the first attached image's bytes so the relay can
		// forward them as `input_reference`. Only one ref is honored — the
		// OpenAI /v1/videos spec is single-reference, and bridge ComfyUI
		// I2V workflows declare a single `image_inputs` entry.
		let inputReference: { bytes: Buffer; contentType: string } | undefined;
		if (dispatchMediaIds.length > 0) {
			const loaded = await loadMediaBytes(dispatchMediaIds[0], locals.user.id);
			inputReference = { bytes: loaded.bytes, contentType: loaded.contentType };
			if (DEBUG) {
				console.debug(
					`[messages] i2v with input_reference: ${loaded.contentType}:${loaded.bytes.byteLength}B prompt="${promptText.slice(0, 60)}"`,
				);
			}
		}
		const stream = startVideoRelay({
			conversationId: params.id,
			userId: locals.user.id,
			conversationTitle: meta.title,
			endpoint,
			storedModelId: meta.modelId,
			prompt: promptText,
			userMessage: userMessage as ChatMessage,
			inputReference,
			sourceMediaId,
			abortSignal: inFlight.controller.signal,
			advanceActiveLeaf: !isFanout,
			suppressTitleTask: isFanout,
			onStarted: () => {
				inFlight.generationStartedAt = Date.now();
			},
			// Stash the bridge job id on our in-flight entry so the cancel
			// endpoint can DELETE /v1/videos/{id} for this branch.
			onJobId: (jobId) => {
				inFlight.videoJobId = jobId;
			},
			// Clear the registry slot when the relay's work is done — not
			// when the response stream cancels. An iOS suspension drops
			// the client SSE connection minutes before the polling loop
			// finishes, and the chat page's recovery indicator depends on
			// the slot staying populated until the generation truly ends.
			onComplete: () => clearInFlight(params.id, inFlight),
		});
		return new Response(stream, {
			headers: {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache, no-store, no-transform',
				Connection: 'keep-alive',
				'X-Accel-Buffering': 'no',
			},
		});
	}

	// Resolve the system prompt sent upstream. Precedence:
	//   1. The conversation's snapshotted prompt (set when a custom-model
	//      preset or an explicit body.systemPrompt was used at create time).
	//   2. The prefs-derived persona + saved memories, composed from current
	//      prefs/memories and gated by the `personalization` opt-out. Both
	//      re-derived per request so edits propagate to existing chats and
	//      flipping the toggle takes effect on the next send.
	// Hoisted outside the personalization gate because trustedMcpTools is
	// independent of the persona-prompt branch — every turn needs to know
	// which MCP tools to bypass the approval prompt for.
	const prefs = getUserPreferences(locals.user.id);
	let effectiveSystemPrompt: string | null = meta.systemPrompt;
	if (effectiveSystemPrompt === null && !meta.disabledFeatures.includes('personalization')) {
		const memories = listMemoriesForUser(locals.user.id);
		if (prefs) effectiveSystemPrompt = composePersonaSystemPrompt(prefs, memories);
	}

	// Build the upstream request from the active branch (now incl. new user msg).
	// Messages with no image parts forward as plain-string content (best
	// compat with non-vision upstreams). Messages WITH image parts forward
	// as the OpenAI vision-spec structured content array — text parts plus
	// data-url image_url parts. We inline image bytes as data URLs because
	// the upstream's ability to fetch one of our /api/media/:id/content
	// URLs depends on the deployment's reverse-proxy / network topology
	// and we don't want to assume it's reachable. tool_call / tool_result
	// parts serialize to OpenAI's tool-calling shape.
	const branch = walkActiveBranch(params.id);
	const upstreamMessages = await serializeBranchForUpstream(
		branch,
		(mediaId) => mediaIdToDataUrl(mediaId, locals.user.id),
		effectiveSystemPrompt,
	);

	const requestBody: ChatCompletionRequest = {
		model: parsed.upstreamId,
		messages: upstreamMessages,
	};

	// Splice in native tool-calling when the resolved model supports it.
	// Resolution prefers the per-model upstream signal (ModelEntry.supportsTools,
	// populated by normalizeUpstreamModel) and falls back to the endpoint
	// config — both layers already collapsed by the time we read the
	// ModelEntry below.
	const allModels = await listAllModels();
	const modelEntry = allModels.find(
		(m) => m.endpointId === parsed.endpointId && m.upstreamId === parsed.upstreamId,
	);
	// Fan-out branches run single-iteration (no tool loop — a tool_call with
	// no follow-up iteration would leave the model unable to respond to the
	// result), so tools are disabled for them. Fan-out is for comparing model
	// *responses*; tool-using comparison is a deliberate follow-up.
	const supportsTools = (modelEntry?.supportsTools ?? endpoint.supportsTools ?? false) && !isFanout;
	// Block first request after a cold start until MCP discovery has
	// finished — otherwise the model would see a partially-populated tool
	// surface and refuse-to-use later in the turn would surface as flaky
	// behavior. Subsequent calls hit a resolved promise immediately.
	if (supportsTools) await awaitMcpReady();
	// Per-conversation opt-outs filter out whole tool categories (e.g. 'web'
	// closes both web_search and fetch_url so the model can't compose around
	// partial gating). See FEATURE_CATEGORIES and ToolMetadata.category.
	const toolDefs = supportsTools
		? openaiToolDefinitions({ excludeCategories: meta.disabledFeatures })
		: [];
	if (toolDefs.length > 0) {
		requestBody.tools = toolDefs;
		requestBody.tool_choice = 'auto';
	}
	// Materialized custom-model params, if any. Forward only the fields the
	// chat-completions API understands; image/video paths ignore these.
	if (meta.parameters) {
		if (meta.parameters.temperature !== undefined) {
			requestBody.temperature = meta.parameters.temperature;
		}
		if (meta.parameters.top_p !== undefined) {
			requestBody.top_p = meta.parameters.top_p;
		}
		if (meta.parameters.max_tokens !== undefined) {
			requestBody.max_tokens = meta.parameters.max_tokens;
		}
	}

	const wantsStream = url.searchParams.get('stream') === '1';

	if (wantsStream) {
		// Streaming responses omit `usage` unless the caller asks for it.
		// We always want it — it's how the UI surfaces conversation size.
		requestBody.stream_options = { include_usage: true };

		// Closure the relay uses between tool-loop iterations to derive
		// the next upstream body. The conversation's active leaf has
		// advanced to the latest tool result, so re-walking the branch
		// picks up the assistant's tool_calls + the tool messages
		// without us having to track that state in the relay.
		const rebuildRequestBody = async (): Promise<ChatCompletionRequest> => {
			const nextBranch = walkActiveBranch(params.id);
			const nextMessages = await serializeBranchForUpstream(
				nextBranch,
				(mediaId) => mediaIdToDataUrl(mediaId, locals.user.id),
				effectiveSystemPrompt,
			);
			return { ...requestBody, messages: nextMessages };
		};

		// Re-use the prefs loaded above to build the "always allow"
		// allowlist consulted before each MCP tool runs. Built-in tools
		// and user-trusted MCP tools execute inline; untrusted MCP tools
		// halt the turn with an inline approval prompt.
		const trustedSet = new Set(prefs?.trustedMcpTools ?? []);
		const needsApproval = (toolName: string) => {
			if (!toolName.startsWith('mcp__')) return false;
			return !trustedSet.has(toolName);
		};

		const stream = await startStreamingRelay({
			conversationId: params.id,
			userId: locals.user.id,
			conversationTitle: meta.title,
			modelKind: meta.modelKind,
			endpoint,
			providerQuirk: endpoint.providerQuirk,
			requestBody,
			userMessage: userMessage as ChatMessage,
			storedModelId: meta.modelId,
			abortSignal: inFlight.controller.signal,
			// Fan-out branch: persist the assistant as a sibling without
			// advancing the leaf (stays pinned at the shared user message),
			// and don't start a per-branch title task (/prepare owns it once).
			advanceActiveLeaf: !isFanout,
			suppressTitleTask: isFanout,
			onStarted: () => {
				inFlight.generationStartedAt = Date.now();
			},
			// Clear the registry slot once the whole turn settles (all
			// loop iterations + tool executions done), not per recorder.
			// The recorder branches survive client disconnect, so the
			// recovery indicator stays accurate after an iOS PWA suspend.
			onComplete: () => clearInFlight(params.id, inFlight),
			needsApproval,
			// Threaded into each tool's ToolContext so behavior-only
			// consumers (e.g. run_python's Python network shim, which
			// blocks egress when 'web' is off even though run_python is
			// in 'code_interpreter') can honor the conversation's
			// disabled-features without a registry-level filter.
			disabledFeatures: meta.disabledFeatures,
			// Only enable the multi-iteration loop for endpoints whose
			// models actually support tools. Endpoints without tools
			// won't emit tool_calls anyway, but skipping the closure
			// makes the single-iteration path explicit.
			...(toolDefs.length > 0 ? { rebuildRequestBody } : {}),
		});
		return new Response(stream, {
			headers: {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache, no-store, no-transform',
				Connection: 'keep-alive',
				// Defeat reverse-proxy buffering (Nginx/Caddy/CloudFront).
				'X-Accel-Buffering': 'no',
			},
		});
	}

	// JSON / sync path (Phase 5 behavior preserved).
	let upstream;
	try {
		upstream = await chatCompletionSync(endpoint, requestBody);
	} catch (e) {
		clearInFlight(params.id, inFlight);
		if (e instanceof UpstreamError) {
			const status = mapUpstreamStatus(e.status);
			throw error(status, `Upstream error: ${formatUpstreamError(e)}`);
		}
		throw e;
	}
	clearInFlight(params.id, inFlight);

	const assistantText = upstream.choices?.[0]?.message?.content ?? '';
	const finishReason = upstream.choices?.[0]?.finish_reason ?? null;
	const tokensIn = upstream.usage?.prompt_tokens ?? null;
	const tokensOut = upstream.usage?.completion_tokens ?? null;
	const contentHtml = await renderMarkdown(assistantText);

	const assistantMessage = appendMessage({
		conversationId: params.id,
		parentMessageId: userMessage.id,
		role: 'assistant',
		parts: [{ type: 'text', text: assistantText }],
		contentHtml,
		finishReason,
		modelUsed: meta.modelId,
		tokensIn,
		tokensOut,
		rawResponseJson: JSON.stringify(upstream),
	});

	// Title task: same shape as the image branch — fire now (after both
	// user + assistant messages are persisted) and race the bounded
	// delivery budget before returning JSON. Non-streaming chat callers
	// (clients that don't pass `?stream=1`) get the title inline; the
	// generator's conditional UPDATE handles "already AI/user-titled."
	const syncTitle = await raceTitle(
		startTitleTaskIfFirstExchange(params.id),
		TITLE_DELIVERY_BUDGET_MS,
	);

	const response: SendMessageResponse = {
		userMessage: userMessage as ChatMessage,
		assistantMessage: assistantMessage as ChatMessage,
		...(syncTitle ? { title: syncTitle } : {}),
	};
	return json(response);
};

function mapUpstreamStatus(status: number | null): 502 | 504 | 400 {
	if (status === null) return 502;
	if (status === 408 || status === 504) return 504;
	if (status >= 400 && status < 500) return 400;
	return 502;
}
