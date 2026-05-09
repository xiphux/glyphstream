import { error, json } from '@sveltejs/kit';
import {
	getConversationMeta,
	setConversationTitle
} from '$lib/server/db/queries/conversations';
import { appendMessage, walkActiveBranch } from '$lib/server/db/queries/messages';
import { chatCompletionSync, UpstreamError } from '$lib/server/endpoints/client';
import { getEndpoint, parseModelId } from '$lib/server/endpoints/registry';
import type { ChatMessage, MessagePart, SendMessageRequest, SendMessageResponse } from '$lib/types/api';
import type { RequestHandler } from './$types';

const TITLE_PREVIEW_MAX = 60;

export const POST: RequestHandler = async ({ locals, params, request }) => {
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

	// Persist the user message under the current active leaf BEFORE calling
	// upstream. This way if the upstream fails we still have the user's input
	// recorded and the conversation tip moves forward consistently.
	const userParts: MessagePart[] = [{ type: 'text', text }];
	const userMessage = appendMessage({
		conversationId: params.id,
		parentMessageId: meta.activeLeafMessageId,
		role: 'user',
		parts: userParts
	});

	// Auto-title from the first user message if the conversation is unnamed.
	if (!meta.title) {
		const preview = text.length > TITLE_PREVIEW_MAX ? text.slice(0, TITLE_PREVIEW_MAX - 1) + '…' : text;
		setConversationTitle(params.id, preview);
	}

	// Build the request from the active branch (now including the new user msg).
	// walkActiveBranch reflects the just-updated active_leaf, so this is the
	// full prompt history root → leaf.
	const branch = walkActiveBranch(params.id);
	const upstreamMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
	if (meta.systemPrompt) {
		upstreamMessages.push({ role: 'system', content: meta.systemPrompt });
	}
	for (const m of branch) {
		if (m.role === 'tool') continue; // not used in v1
		upstreamMessages.push({
			role: m.role as 'system' | 'user' | 'assistant',
			content: partsToText(m.parts)
		});
	}

	let upstream;
	try {
		upstream = await chatCompletionSync(endpoint, {
			model: parsed.upstreamId,
			messages: upstreamMessages
		});
	} catch (e) {
		if (e instanceof UpstreamError) {
			const status = mapUpstreamStatus(e.status);
			throw error(status, `Upstream error: ${e.message}`);
		}
		throw e;
	}

	const assistantText = upstream.choices?.[0]?.message?.content ?? '';
	const finishReason = upstream.choices?.[0]?.finish_reason ?? null;
	const tokensIn = upstream.usage?.prompt_tokens ?? null;
	const tokensOut = upstream.usage?.completion_tokens ?? null;

	const assistantMessage = appendMessage({
		conversationId: params.id,
		parentMessageId: userMessage.id,
		role: 'assistant',
		parts: [{ type: 'text', text: assistantText }],
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

/** Flatten text parts of a message for the upstream `content` string. */
function partsToText(parts: MessagePart[]): string {
	return parts
		.map((p) => {
			if (p.type === 'text') return p.text;
			if (p.type === 'reasoning') return ''; // reasoning isn't fed back into context (yet)
			// image/video parts are placeholder for v1; multimodal upstreams
			// land in phase 8/9 where we'll structure content differently.
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
