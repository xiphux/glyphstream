import { error, json } from '@sveltejs/kit';
import {
	getConversationMeta,
	setConversationTitle
} from '$lib/server/db/queries/conversations';
import { linkMessageMedia } from '$lib/server/db/queries/media';
import { appendMessage, walkActiveBranch } from '$lib/server/db/queries/messages';
import {
	chatCompletionSync,
	imageGeneration,
	UpstreamError,
	type ChatCompletionRequest
} from '$lib/server/endpoints/client';
import { getEndpoint, parseModelId } from '$lib/server/endpoints/registry';
import { logLevel } from '$lib/server/env';
import { renderMarkdown } from '$lib/server/markdown/render';
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
	const text = body.text?.trim();
	if (!text) throw error(400, "'text' is required and must be non-empty");

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

	// Persist user message + auto-title BEFORE upstream call so even if the
	// upstream fails the user's input is preserved on the active branch.
	const userParts: MessagePart[] = [{ type: 'text', text }];
	const userMessage = appendMessage({
		conversationId: params.id,
		parentMessageId: meta.activeLeafMessageId,
		role: 'user',
		parts: userParts
	});
	if (!meta.title) {
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
				throw error(mapUpstreamStatus(e.status), `Upstream error: ${e.message}`);
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
	const branch = walkActiveBranch(params.id);
	const upstreamMessages: ChatCompletionRequest['messages'] = [];
	if (meta.systemPrompt) {
		upstreamMessages.push({ role: 'system', content: meta.systemPrompt });
	}
	for (const m of branch) {
		if (m.role === 'tool') continue;
		upstreamMessages.push({
			role: m.role as 'system' | 'user' | 'assistant',
			content: partsToText(m.parts)
		});
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
			throw error(status, `Upstream error: ${e.message}`);
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
