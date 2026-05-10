import { error, json } from '@sveltejs/kit';
import {
	getConversationMeta,
	setConversationTitle
} from '$lib/server/db/queries/conversations';
import { getMediaForUser, linkMessageMedia } from '$lib/server/db/queries/media';
import { appendMessage, walkActiveBranch } from '$lib/server/db/queries/messages';
import {
	chatCompletionSync,
	formatUpstreamError,
	imageGeneration,
	UpstreamError,
	type ChatCompletionContentPart,
	type ChatCompletionRequest
} from '$lib/server/endpoints/client';
import { getEndpoint, parseModelId } from '$lib/server/endpoints/registry';
import { logLevel } from '$lib/server/env';
import { renderMarkdown } from '$lib/server/markdown/render';
import { mediaIdToDataUrl } from '$lib/server/media/data-url';
import { persistGeneratedImage } from '$lib/server/media/persister';
import { clearInFlight, registerInFlight } from '$lib/server/streaming/in-flight';
import { startStreamingRelay } from '$lib/server/streaming/relay';
import { startVideoRelay } from '$lib/server/streaming/video-relay';

const DEBUG = logLevel() === 'debug';
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
	const text = body.text?.trim() ?? '';
	const attachedMediaIds = Array.isArray(body.attachedMediaIds)
		? body.attachedMediaIds.filter((s): s is string => typeof s === 'string')
		: [];
	if (!text && attachedMediaIds.length === 0) {
		throw error(400, "'text' or 'attachedMediaIds' is required");
	}

	const meta = getConversationMeta(params.id, locals.user.id);
	if (!meta) throw error(404, 'Conversation not found');

	const parsed = parseModelId(meta.modelId);
	if (!parsed) {
		throw error(500, `Stored model id "${meta.modelId}" is malformed`);
	}
	const endpoint = getEndpoint(parsed.endpointId);
	if (!endpoint) {
		throw error(
			502,
			`Endpoint "${parsed.endpointId}" referenced by this conversation is not configured`
		);
	}

	// Validate every attached media id belongs to this user and isn't
	// hard-deleted before we persist anything — so a tampered request can't
	// land an unowned-media reference on a real conversation row.
	for (const mid of attachedMediaIds) {
		const m = getMediaForUser(mid, locals.user.id);
		if (!m || m.hardDeletedAt !== null) {
			throw error(400, `Attached media "${mid}" not found`);
		}
	}

	// Persist user message + auto-title BEFORE upstream call so even if the
	// upstream fails the user's input is preserved on the active branch.
	// Image parts come after the text part so the UI renders text-then-images
	// (matches the natural reading order of "<words>; here are the pictures").
	const userParts: MessagePart[] = [];
	if (text) userParts.push({ type: 'text', text });
	for (const mid of attachedMediaIds) {
		userParts.push({ type: 'image', mediaId: mid });
	}
	const userMessage = appendMessage({
		conversationId: params.id,
		parentMessageId: meta.activeLeafMessageId,
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

	if (DEBUG) {
		console.debug(
			`[messages] dispatch conversation=${params.id} modelKind=${meta.modelKind} modelId=${meta.modelId} stream=${url.searchParams.get('stream') === '1'}`
		);
	}

	// Register this generation so POST /api/conversations/:id/cancel can
	// reach the upstream call and abort it. We pass the signal down through
	// every code path that talks to upstream.
	const inFlight = registerInFlight(params.id, endpoint);

	// --- image-kind models: prompt → image; no streaming, no chat history -----
	if (meta.modelKind === 'image') {
		try {
			const upstream = await imageGeneration(
				endpoint,
				{
					model: parsed.upstreamId,
					prompt: text,
					n: 1,
					response_format: 'url'
				},
				inFlight.controller.signal
			);
			const result = upstream.data?.[0];
			if (!result || (!result.url && !result.b64_json)) {
				throw error(502, 'Upstream returned no image data');
			}
			const mediaId = await persistGeneratedImage({
				userId: locals.user.id,
				endpoint,
				sourceModel: meta.modelId,
				prompt: text,
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
			const response: SendMessageResponse = {
				userMessage: userMessage as ChatMessage,
				assistantMessage: assistantMessage as ChatMessage
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
		const stream = startVideoRelay({
			conversationId: params.id,
			userId: locals.user.id,
			endpoint,
			storedModelId: meta.modelId,
			prompt: text,
			userMessage: userMessage as ChatMessage,
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

	const response: SendMessageResponse = {
		userMessage: userMessage as ChatMessage,
		assistantMessage: assistantMessage as ChatMessage
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
