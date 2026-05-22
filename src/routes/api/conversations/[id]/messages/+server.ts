import type { Buffer } from 'node:buffer';
import { error, json } from '@sveltejs/kit';
import {
	getConversationMeta,
	setConversationTitle,
	updateConversationModel
} from '$lib/server/db/queries/conversations';
import { getMediaForUser, linkMessageMedia } from '$lib/server/db/queries/media';
import {
	appendMessage,
	getMessage,
	resolveParentForUserMessage,
	setActiveLeafMessageId,
	walkActiveBranch
} from '$lib/server/db/queries/messages';
import {
	chatCompletionSync,
	formatUpstreamError,
	imageEdit,
	imageGeneration,
	UpstreamError,
	type ChatCompletionContentPart,
	type ChatCompletionRequest,
	type ImageEditInputFile
} from '$lib/server/endpoints/client';
import { getEndpoint } from '$lib/server/endpoints/registry';
import { parseModelId } from '$lib/server/endpoints/model-id';
import { logLevel } from '$lib/server/env';
import { renderMarkdown } from '$lib/server/markdown/render';
import { loadMediaBytes, mediaIdToDataUrl } from '$lib/server/media/data-url';
import { persistGeneratedImage } from '$lib/server/media/persister';
import { notifyConversationComplete } from '$lib/server/push/notify';
import { clearInFlight, registerInFlight } from '$lib/server/streaming/in-flight';
import { startStreamingRelay } from '$lib/server/streaming/relay';
import { startVideoRelay } from '$lib/server/streaming/video-relay';
import { raceTitle, startTitleTaskIfFirstExchange } from '$lib/server/tasks/title-task-runner';

const TITLE_DELIVERY_BUDGET_MS = 5000;

const DEBUG = logLevel() === 'debug';
import { isModelKind } from '$lib/types/api';
import type {
	ChatMessage,
	MessagePart,
	SendMessageRequest,
	SendMessageResponse
} from '$lib/types/api';
import type { RequestHandler } from './$types';

const TITLE_PREVIEW_MAX = 60;

export const POST: RequestHandler = async ({ locals, params, request, url }) => {
	if (!locals.user) throw error(401, 'Authentication required');

	let body: SendMessageRequest;
	try {
		body = (await request.json()) as SendMessageRequest;
	} catch {
		throw error(400, 'Request body must be JSON');
	}
	const isRetry = typeof body.regenerateFromMessageId === 'string' && body.regenerateFromMessageId;
	const text = body.text?.trim() ?? '';
	const attachedMediaIds = Array.isArray(body.attachedMediaIds)
		? body.attachedMediaIds.filter((s): s is string => typeof s === 'string')
		: [];
	if (!isRetry && !text && attachedMediaIds.length === 0) {
		throw error(400, "'text' or 'attachedMediaIds' is required");
	}

	const meta = getConversationMeta(params.id, locals.user.id);
	if (!meta) throw error(404, 'Conversation not found');

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
		updateConversationModel(params.id, locals.user.id, {
			endpointId: newParsed.endpointId,
			modelId: body.modelId,
			modelKind: newKind
		});
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
			'This conversation has no valid model. Pick one from the model picker before sending.'
		);
	}
	const endpoint = getEndpoint(parsed.endpointId)!;

	// `userMessage` is the anchor that the assistant message hangs off of.
	// For a regular send it's a freshly-persisted row; for a retry it's
	// the existing user message that prompted the assistant turn we're
	// regenerating. Either way the dispatcher uses it as the parent for
	// the new assistant message.
	let userMessage;
	if (isRetry) {
		const target = getMessage(params.id, body.regenerateFromMessageId!);
		if (!target) throw error(404, `Message "${body.regenerateFromMessageId}" not found`);
		if (target.role !== 'assistant') {
			throw error(400, 'regenerateFromMessageId must reference an assistant message');
		}
		if (!target.parentMessageId) {
			throw error(400, 'Cannot retry a root message');
		}
		const parentUser = getMessage(params.id, target.parentMessageId);
		if (!parentUser || parentUser.role !== 'user') {
			throw error(400, 'Retry target has no user-message parent');
		}
		// Re-anchor the active branch at the parent user message — walks
		// from here build the upstream request from history-up-to-the-
		// retry-point, and the new assistant becomes a sibling of the one
		// being retried (both children of `parentUser`).
		setActiveLeafMessageId(params.id, parentUser.id);
		userMessage = parentUser;
	} else {
		// Validate every attached media id belongs to this user and isn't
		// hard-deleted before we persist anything — so a tampered request
		// can't land an unowned-media reference on a real conversation row.
		for (const mid of attachedMediaIds) {
			const m = getMediaForUser(mid, locals.user.id);
			if (!m || m.hardDeletedAt !== null) {
				throw error(400, `Attached media "${mid}" not found`);
			}
		}

		// Resolve the parent for the new user message. See
		// `resolveParentForUserMessage` for the three cases (edit /
		// explicit parent / active-leaf append). The helper returns a
		// discriminated result so we can map misses to the right 400
		// without coupling the helper itself to SvelteKit's error
		// machinery — that separation is what makes it cleanly unit-
		// testable.
		const resolved = resolveParentForUserMessage({
			conversationId: params.id,
			activeLeafMessageId: meta.activeLeafMessageId ?? null,
			editedMessageId: body.editedMessageId,
			parentMessageId: body.parentMessageId
		});
		if (!resolved.ok) {
			const field =
				resolved.reason === 'edited-message-not-found'
					? 'editedMessageId'
					: 'parentMessageId';
			throw error(400, `${field} "${resolved.id}" not found`);
		}
		const parentForMessage = resolved.parentMessageId;

		// Persist user message + auto-title BEFORE upstream call so even if
		// the upstream fails the user's input is preserved on the active
		// branch. Image parts come after the text part so the UI renders
		// text-then-images (the natural reading order of "<words>; here
		// are the pictures").
		const userParts: MessagePart[] = [];
		if (text) userParts.push({ type: 'text', text });
		for (const mid of attachedMediaIds) {
			userParts.push({ type: 'image', mediaId: mid });
		}
		userMessage = appendMessage({
			conversationId: params.id,
			parentMessageId: parentForMessage,
			role: 'user',
			parts: userParts
		});
		for (const mid of attachedMediaIds) {
			linkMessageMedia(userMessage.id, mid);
		}
		if (!meta.title && text) {
			const preview =
				text.length > TITLE_PREVIEW_MAX ? text.slice(0, TITLE_PREVIEW_MAX - 1) + '…' : text;
			setConversationTitle(params.id, preview);
		}
	}

	if (DEBUG) {
		console.debug(
			`[messages] dispatch conversation=${params.id} modelKind=${meta.modelKind} modelId=${meta.modelId} stream=${url.searchParams.get('stream') === '1'}${isRetry ? ' retry=1' : ''}`
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
	const dispatchMediaIds = userMessage.parts
		.filter((p): p is { type: 'image'; mediaId: string } => p.type === 'image')
		.map((p) => p.mediaId);

	// Register this generation so POST /api/conversations/:id/cancel can
	// reach the upstream call and abort it. We pass the signal down through
	// every code path that talks to upstream.
	const inFlight = registerInFlight(params.id, endpoint);

	// --- image-kind models: prompt → image; no streaming, no chat history -----
	if (meta.modelKind === 'image') {
		// Kick off title gen in parallel with image generation — for image
		// modality the user prompt IS the topic, so the title task doesn't
		// have to wait for the asset to land. By the time `imageGeneration`
		// returns (typically multiple seconds), the title is usually ready.
		const titlePromise = startTitleTaskIfFirstExchange(params.id);

		try {
			// I2I: route to /v1/images/edits when any image is attached;
			// otherwise t2i via /v1/images/generations. Multiple attachments
			// go through as repeated `image` fields — the bridge's ComfyUI
			// workflows that declare multiple `image_inputs` consume them in
			// order; OpenAI's spec only honors the first.
			let upstream;
			if (dispatchMediaIds.length > 0) {
				const images: ImageEditInputFile[] = [];
				for (const mid of dispatchMediaIds) {
					const loaded = await loadMediaBytes(mid, locals.user.id);
					images.push({ bytes: loaded.bytes, contentType: loaded.contentType });
				}
				if (DEBUG) {
					const summary = images
						.map((i) => `${i.contentType}:${i.bytes.byteLength}B`)
						.join(', ');
					console.debug(
						`[messages] i2i edit → /images/edits: ${images.length} input(s) [${summary}] prompt="${promptText.slice(0, 60)}"`
					);
				}
				upstream = await imageEdit(
					endpoint,
					{
						model: parsed.upstreamId,
						prompt: promptText,
						images,
						n: 1,
						response_format: 'url'
					},
					inFlight.controller.signal
				);
			} else {
				if (DEBUG) {
					console.debug(
						`[messages] t2i generate → /images/generations: prompt="${promptText.slice(0, 60)}"`
					);
				}
				upstream = await imageGeneration(
					endpoint,
					{
						model: parsed.upstreamId,
						prompt: promptText,
						n: 1,
						response_format: 'url'
					},
					inFlight.controller.signal
				);
			}
			const result = upstream.data?.[0];
			if (!result || (!result.url && !result.b64_json)) {
				throw error(502, 'Upstream returned no image data');
			}
			const mediaId = await persistGeneratedImage({
				userId: locals.user.id,
				endpoint,
				sourceModel: meta.modelId,
				prompt: promptText,
				urlOrB64: { url: result.url, b64_json: result.b64_json }
			});
			const assistantMessage = appendMessage({
				conversationId: params.id,
				parentMessageId: userMessage.id,
				role: 'assistant',
				parts: [{ type: 'image', mediaId }],
				modelUsed: meta.modelId,
				rawResponseJson: JSON.stringify(upstream)
			});
			linkMessageMedia(assistantMessage.id, mediaId);
			void notifyConversationComplete({
				userId: locals.user.id,
				conversationId: params.id,
				assistantMessageId: assistantMessage.id,
				conversationTitle: meta.title ?? 'New conversation',
				previewText: '',
				modality: 'image'
			}).catch((e) => console.warn('[messages] image notify failed:', e));
			// Race the title task against a bounded budget so a slow task
			// model never delays the image response. Title gen has been
			// running since before imageGeneration started, so the typical
			// case is "title already resolved by now."
			const title = await raceTitle(titlePromise, TITLE_DELIVERY_BUDGET_MS);
			const response: SendMessageResponse = {
				userMessage: userMessage as ChatMessage,
				assistantMessage: assistantMessage as ChatMessage,
				...(title ? { title } : {})
			};
			return json(response);
		} catch (e) {
			if (inFlight.controller.signal.aborted) {
				// User clicked Stop. Don't persist a noisy "failed" assistant
				// message — the user message stays, they can resend.
				throw error(499, 'Cancelled');
			}
			if (e instanceof UpstreamError) {
				throw error(mapUpstreamStatus(e.status), `Upstream error: ${formatUpstreamError(e)}`);
			}
			throw e;
		} finally {
			clearInFlight(params.id, inFlight);
		}
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
					`[messages] i2v with input_reference: ${loaded.contentType}:${loaded.bytes.byteLength}B prompt="${promptText.slice(0, 60)}"`
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
			abortSignal: inFlight.controller.signal
		});
		return new Response(wrapStreamCleanup(stream, () => clearInFlight(params.id, inFlight)), {
			headers: {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache, no-store, no-transform',
				Connection: 'keep-alive',
				'X-Accel-Buffering': 'no'
			}
		});
	}

	// Build the upstream request from the active branch (now incl. new user msg).
	// Messages with no image parts forward as plain-string content (best
	// compat with non-vision upstreams). Messages WITH image parts forward
	// as the OpenAI vision-spec structured content array — text parts plus
	// data-url image_url parts. We inline image bytes as data URLs because
	// the upstream's ability to fetch one of our /api/media/:id/content
	// URLs depends on the deployment's reverse-proxy / network topology
	// and we don't want to assume it's reachable.
	const branch = walkActiveBranch(params.id);
	const upstreamMessages: ChatCompletionRequest['messages'] = [];
	if (meta.systemPrompt) {
		upstreamMessages.push({ role: 'system', content: meta.systemPrompt });
	}
	for (const m of branch) {
		if (m.role === 'tool') continue;
		const hasImages = m.parts.some((p) => p.type === 'image');
		if (hasImages) {
			const content: ChatCompletionContentPart[] = [];
			for (const p of m.parts) {
				if (p.type === 'text' && p.text) {
					content.push({ type: 'text', text: p.text });
				} else if (p.type === 'image') {
					const url = await mediaIdToDataUrl(p.mediaId, locals.user.id);
					content.push({ type: 'image_url', image_url: { url } });
				}
			}
			upstreamMessages.push({ role: m.role as 'system' | 'user' | 'assistant', content });
		} else {
			upstreamMessages.push({
				role: m.role as 'system' | 'user' | 'assistant',
				content: partsToText(m.parts)
			});
		}
	}

	const requestBody: ChatCompletionRequest = {
		model: parsed.upstreamId,
		messages: upstreamMessages
	};
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
			abortSignal: inFlight.controller.signal
		});
		return new Response(wrapStreamCleanup(stream, () => clearInFlight(params.id, inFlight)), {
			headers: {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache, no-store, no-transform',
				Connection: 'keep-alive',
				// Defeat reverse-proxy buffering (Nginx/Caddy/CloudFront).
				'X-Accel-Buffering': 'no'
			}
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
		rawResponseJson: JSON.stringify(upstream)
	});

	// Title task: same shape as the image branch — fire now (after both
	// user + assistant messages are persisted) and race the bounded
	// delivery budget before returning JSON. Non-streaming chat callers
	// (clients that don't pass `?stream=1`) get the title inline; the
	// generator's conditional UPDATE handles "already AI/user-titled."
	const syncTitle = await raceTitle(
		startTitleTaskIfFirstExchange(params.id),
		TITLE_DELIVERY_BUDGET_MS
	);

	const response: SendMessageResponse = {
		userMessage: userMessage as ChatMessage,
		assistantMessage: assistantMessage as ChatMessage,
		...(syncTitle ? { title: syncTitle } : {})
	};
	return json(response);
};

/**
 * Wrap a ReadableStream so `cleanup` runs once the stream finishes (whether
 * via normal close, error, or the consumer cancelling). Used to clear the
 * in-flight registry slot when an SSE response ends.
 */
function wrapStreamCleanup(
	source: ReadableStream<Uint8Array>,
	cleanup: () => void
): ReadableStream<Uint8Array> {
	let done = false;
	const fire = () => {
		if (!done) {
			done = true;
			try {
				cleanup();
			} catch (e) {
				console.warn('[messages] cleanup callback failed:', e);
			}
		}
	};
	const reader = source.getReader();
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { value, done: closed } = await reader.read();
				if (closed) {
					fire();
					controller.close();
					return;
				}
				if (value !== undefined) controller.enqueue(value);
			} catch (e) {
				fire();
				controller.error(e);
			}
		},
		cancel(reason) {
			fire();
			return reader.cancel(reason);
		}
	});
}

function partsToText(parts: MessagePart[]): string {
	return parts
		.map((p) => {
			if (p.type === 'text') return p.text;
			if (p.type === 'reasoning') return '';
			return '';
		})
		.join('');
}

function mapUpstreamStatus(status: number | null): 502 | 504 | 400 {
	if (status === null) return 502;
	if (status === 408 || status === 504) return 504;
	if (status >= 400 && status < 500) return 400;
	return 502;
}
