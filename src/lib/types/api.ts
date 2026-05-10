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
	/**
	 * Underlying provider/owner from upstream's `owned_by` field. For an
	 * aggregating endpoint like the bridge this distinguishes
	 * comfyui/venice/etc. within a single endpoint; for direct vendors it
	 * just identifies the vendor (openai/anthropic/etc.). Null when upstream
	 * didn't set it.
	 */
	ownedBy: string | null;
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
	/** Parent in the message tree. Optional — populated only by lookups
	 * that need it (retry validation, branch nav). The walkActiveBranch
	 * path doesn't bother filling it because the array order already
	 * encodes parent → child. */
	parentMessageId?: string | null;
	/**
	 * Branching metadata — populated only when this message is on the active
	 * branch returned by walkActiveBranch. Lets the renderer show a
	 * `‹ N/M ›` indicator + the IDs to navigate to when the user clicks.
	 *
	 * When `siblingCount` is 1 (just this message under its parent), nothing
	 * is rendered. When > 1, the indicator appears with this message's
	 * 1-indexed `siblingPosition` (chronological by created_at) and
	 * `siblingIds` ordered the same way (this message included).
	 */
	siblingCount?: number;
	siblingPosition?: number;
	siblingIds?: string[];
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
	parameters: CustomModelParameters | null;
	endpointId: string;
	customModelId: string | null;
	activeLeafMessageId: string | null;
	messages: ChatMessage[];
}

/** POST /api/conversations request body.
 *
 * Either `modelId` (base upstream model) or `customModelId` (saved preset)
 * must be supplied. When `customModelId` is set, the server resolves the
 * base model + system prompt + parameters from the custom model row at
 * creation time and ignores most other fields.
 */
export interface CreateConversationRequest {
	modelId?: string;
	/** Snapshot of the model's kind at create time. Defaults to 'chat' if omitted. */
	modelKind?: ModelKind;
	systemPrompt?: string;
	customModelId?: string;
	title?: string;
}

// --- custom models -----------------------------------------------------

/**
 * Sampling/generation parameters carried with chat custom-models. v1
 * supports the universally-meaningful chat triplet; image/video-specific
 * params (size, seconds, quality) can be added later without breaking
 * existing rows since this is stored as freeform JSON.
 */
export interface CustomModelParameters {
	temperature?: number;
	top_p?: number;
	max_tokens?: number;
}

export interface CustomModel {
	id: string;
	name: string;
	description: string | null;
	baseEndpointId: string;
	baseModelId: string;
	systemPrompt: string | null;
	parameters: CustomModelParameters | null;
	createdAt: number;
	updatedAt: number;
}

export interface CreateCustomModelRequest {
	name: string;
	description?: string;
	baseEndpointId: string;
	baseModelId: string;
	systemPrompt?: string;
	parameters?: CustomModelParameters;
}

export type UpdateCustomModelRequest = Partial<CreateCustomModelRequest>;

/**
 * POST /api/conversations/:id/messages request body.
 *
 * `text` may be empty when `attachedMediaIds` is non-empty (e.g. "describe
 * this image" with the image alone, or an I2I edit where the prompt is
 * implicit). At least one of the two must be present; the server returns
 * 400 if both are missing.
 */
export interface SendMessageRequest {
	text: string;
	/** Media ids previously created by POST /api/uploads, attached to this user message. */
	attachedMediaIds?: string[];
	/**
	 * Override the default "child of active_leaf" parent for the new
	 * user message. Used by the Edit flow — passing the original user
	 * message's parent makes the new message a sibling of the original.
	 * The original + its descendants stay in the DB as an alt branch.
	 */
	parentMessageId?: string;
	/**
	 * "Retry" — when set, the server generates a new assistant response
	 * as a sibling of this assistant message (parented to the same user
	 * message that prompted it). `text` and `attachedMediaIds` are
	 * ignored when this is set.
	 */
	regenerateFromMessageId?: string;
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

/** Long-running operations (video) emit progress updates. percent is 0–100 if known. */
export interface StreamProgressEvent {
	type: 'progress';
	percent: number | null;
	status?: string;
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
	| StreamProgressEvent
	| StreamDoneEvent
	| StreamErrorEvent;
