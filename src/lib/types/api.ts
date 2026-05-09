/** Shared types between server endpoints and client code. */

/** Non-standard extensions agreed with openai-api-bridge; other upstreams may also set them. */
export type ModelKind = 'chat' | 'embedding' | 'image' | 'video';

/** A model as returned by `GET /api/models` (one row per upstream model, prefixed). */
export interface ModelEntry {
	/** Internal id: `{endpoint_id}::{upstream_model_id}` */
	id: string;
	/** Convenience: which endpoint this model is exposed by */
	endpointId: string;
	/** Convenience: the bare upstream model id (no endpoint prefix) */
	upstreamId: string;
	/** Best display name we have — falls back to upstream id if upstream didn't set display_name */
	displayName: string;
	/** Modality, when known. Defaults to 'chat' (the safest fallback) when upstream didn't set it. */
	kind: ModelKind;
	/** True when upstream actually told us the kind, false when we fell back to default */
	kindKnown: boolean;
}

/**
 * Standard OpenAI /v1/models row, plus optional extensions from various
 * vendors. We attempt to detect kind from any of these conventions; see
 * src/lib/server/endpoints/models.ts.
 */
export interface UpstreamModel {
	id: string;
	object?: 'model';
	created?: number;
	owned_by?: string;
	/** openai-api-bridge convention */
	display_name?: string;
	/** openai-api-bridge convention */
	kind?: ModelKind | null;
	/** Together.ai convention: "chat" | "embedding" | "image" | "moderation" */
	type?: string;
	/** OpenRouter convention */
	architecture?: {
		modality?: string;
		input_modalities?: string[];
		output_modalities?: string[];
	};
	/** Fireworks-ish convention */
	capabilities?: string[];
}

// --- messages -----------------------------------------------------------
// Structured content parts. v1 only emits `text`; image/video/reasoning are
// reserved for phases 6/8/9. Additive shape: future tool_call etc. just adds
// a new variant without breaking persisted rows.

export type MessagePart =
	| { type: 'text'; text: string }
	| { type: 'image'; mediaId: string; alt?: string }
	| { type: 'video'; mediaId: string }
	| { type: 'reasoning'; text: string };

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
	id: string;
	role: MessageRole;
	parts: MessagePart[];
	/** Server-rendered markdown HTML (assistant messages only). Null = render `parts` as plain text. */
	contentHtml: string | null;
	reasoningText: string | null;
	finishReason: string | null;
	modelUsed: string | null;
	tokensIn: number | null;
	tokensOut: number | null;
	createdAt: number;
}

export interface ConversationSummary {
	id: string;
	title: string | null;
	modelId: string;
	createdAt: number;
	updatedAt: number;
}

export interface ConversationDetail extends ConversationSummary {
	modelKind: ModelKind | null;
	systemPrompt: string | null;
	endpointId: string;
	customModelId: string | null;
	activeLeafMessageId: string | null;
	messages: ChatMessage[];
}

/** POST /api/conversations request body. */
export interface CreateConversationRequest {
	modelId: string;
	/** Snapshot of the model's kind at create time. Defaults to 'chat' if omitted. */
	modelKind?: ModelKind;
	systemPrompt?: string;
	customModelId?: string;
	title?: string;
}

/** POST /api/conversations/:id/messages request body (v1: text-only). */
export interface SendMessageRequest {
	text: string;
}

/** POST /api/conversations/:id/messages response (sync mode). */
export interface SendMessageResponse {
	userMessage: ChatMessage;
	assistantMessage: ChatMessage;
}

// --- streaming event protocol (server → client SSE) ----------------------
//
// Server normalizes upstream SSE per provider quirk and emits these events.
// Client consumes and renders without needing to know about provider quirks.

export interface StreamTextEvent {
	type: 'text';
	chunk: string;
}

export interface StreamReasoningEvent {
	type: 'reasoning';
	chunk: string;
}

/** Sent once at the start so client knows the user/assistant ids ahead of streaming. */
export interface StreamStartEvent {
	type: 'start';
	userMessage: ChatMessage;
	assistantMessageId: string;
}

/** Sent at the end with the canonical persisted message (replaces in-flight render). */
export interface StreamDoneEvent {
	type: 'done';
	assistantMessage: ChatMessage;
}

export interface StreamErrorEvent {
	type: 'error';
	message: string;
}

export type StreamEvent =
	| StreamStartEvent
	| StreamTextEvent
	| StreamReasoningEvent
	| StreamDoneEvent
	| StreamErrorEvent;
