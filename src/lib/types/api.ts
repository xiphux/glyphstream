/** Shared types between server endpoints and client code. */

/**
 * The model modalities GlyphStream understands. MODEL_KINDS is the single
 * source of truth — ModelKind is derived from it and isModelKind is the
 * runtime guard for untrusted input (request bodies, upstream /v1/models
 * responses, config).
 *
 * (Non-standard extensions agreed with openai-api-bridge; other upstreams
 * may also set them.)
 */
export const MODEL_KINDS = ['chat', 'embedding', 'image', 'video'] as const;

export type ModelKind = (typeof MODEL_KINDS)[number];

/** Runtime guard: true when `v` is one of the known model kinds. */
export function isModelKind(v: unknown): v is ModelKind {
	return typeof v === 'string' && (MODEL_KINDS as readonly string[]).includes(v);
}

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
	/**
	 * Human-readable label for the group this model should appear under in
	 * the picker. Defaults to the endpoint's displayName; if the endpoint
	 * sets `group_by = "owned_by"` in config.toml the upstream's `owned_by`
	 * is used instead (so e.g. an aggregating bridge fans out into its
	 * underlying provider buckets — openrouter / venice / comfyui).
	 * Falls back to endpoint.displayName when groupBy='owned_by' but the
	 * model lacks an owned_by value.
	 */
	group: string;
	/**
	 * Stable identifier for the group. Used for grouping/dedup in the
	 * picker; falls back to endpointId when owned_by is missing.
	 */
	groupKey: string;
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
	/** Parent in the message tree. Populated by `walkActiveBranch` and
	 * `getMessage`. Used by Edit (sibling parent for the new message)
	 * and Retry (parent user message of the assistant being retried). */
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

// --- user preferences --------------------------------------------------
//
// User-level settings that apply globally unless overridden by a more
// specific scope (a custom-model preset's system_prompt overrides the
// user-level default at conversation creation, for example).
//
// JSON-encoded in users.preferences_json so adding a new preference is a
// type-level change only — no DB migration. The parser in
// server/db/queries/user-preferences.ts validates each field defensively
// and fills in defaults for absent/invalid values.

/** How the message composer treats the Enter key. */
export type EnterBehavior = 'send' | 'newline';

export interface UserPreferences {
	/**
	 * The three personalization fields below are combined server-side
	 * (via composePersonaSystemPrompt in user-preferences.ts) into a
	 * single system prompt at conversation-create time. Splitting them
	 * gives users discoverable structure — "Name" prompts you to enter
	 * one, "About you" prompts you to think about standing context,
	 * "Custom instructions" prompts you to think about tone/style —
	 * rather than handing them a blank textarea with no scaffolding.
	 * All three are optional; empty fields are omitted from the
	 * composed prompt entirely (no "Name: (blank)" leaks).
	 */
	/** How the user wants the assistant to refer to them. */
	name: string;
	/** Standing context about the user — occupation, interests, what
	 * they're typically working on. Free-form. */
	aboutYou: string;
	/** Additional instructions for the assistant — tone, response
	 * style, formatting preferences. Free-form. */
	customInstructions: string;
	/** "send": Enter sends, Shift+Enter inserts a newline (default).
	 *  "newline": Enter inserts a newline, Cmd/Ctrl+Enter sends. */
	enterBehavior: EnterBehavior;
	/** Whether to display the "Good morning, {name}" greeting on the
	 * new-chat page. Default true; minority of users may prefer the
	 * cleaner header without familial address. */
	showGreeting: boolean;
	/**
	 * Master switch for browser/OS push notifications when an assistant
	 * message completes. Default false — push requires an explicit
	 * opt-in (permission prompt + subscription stored server-side). The
	 * service worker arbitrates per push: silent when the user is on
	 * the same thread, otherwise toast (if foreground) or OS notification
	 * (if backgrounded). On iOS, the underlying Web Push API is only
	 * available after the PWA is installed to the Home Screen.
	 */
	notificationsEnabled: boolean;
	/**
	 * Whether OS notifications may include a content preview of the
	 * assistant message. Default false — privacy-conservative so the
	 * preview text never traverses the push service for users who
	 * haven't opted in. Server side, the preview is omitted from the
	 * payload entirely when this is false (not just hidden in the SW).
	 */
	notificationsShowContent: boolean;
	/**
	 * Whether the in-app toast fires when a thread completes while the
	 * user is on a different thread/page (tab still visible). Default
	 * true; some users may prefer silent foreground behavior and OS
	 * notifications only for backgrounded states.
	 */
	notificationsForegroundToast: boolean;
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
	 * user message. Used historically by the Edit flow — passing the
	 * original user message's parent made the new message a sibling
	 * of the original. Still accepted as a fallback for callers that
	 * already construct it; the cleaner contract is `editedMessageId`
	 * below, which lets the server derive the parent (and correctly
	 * handles the root-edit case where the parent is itself null).
	 */
	parentMessageId?: string;
	/**
	 * "Edit" — when set, the new user message becomes a sibling of
	 * the message with this id (i.e. its parent_message_id is copied
	 * from the edited message). Critically handles root edits: the
	 * edited message's parent_message_id may be null, in which case
	 * the new sibling is a fresh root rather than a continuation of
	 * the current branch. Takes precedence over `parentMessageId`
	 * when both are sent.
	 */
	editedMessageId?: string;
	/**
	 * "Retry" — when set, the server generates a new assistant response
	 * as a sibling of this assistant message (parented to the same user
	 * message that prompted it). `text` and `attachedMediaIds` are
	 * ignored when this is set.
	 */
	regenerateFromMessageId?: string;
	/**
	 * Per-turn model override. When supplied and different from the
	 * conversation's stored model, the server updates
	 * `conversations.endpoint_id` / `model_id` / `model_kind` before
	 * dispatching this turn — so subsequent turns continue with the new
	 * model unless overridden again. The conversation's system prompt /
	 * parameters / custom-model link are NOT touched: switching *model*
	 * doesn't change *persona*. Use case: pivot to a stronger model mid-
	 * conversation, or pick a real model for an imported OWUI chat
	 * (which lands with a synthetic endpoint id).
	 */
	modelId?: string;
	/** Modality of the override model. Required when `modelId` is set. */
	modelKind?: ModelKind;
}

/** POST /api/conversations/:id/messages response (sync mode). */
export interface SendMessageResponse {
	userMessage: ChatMessage;
	assistantMessage: ChatMessage;
	/**
	 * Set when the task model generated a title for this conversation as
	 * part of this exchange. Image-modality conversations don't stream, so
	 * the title piggybacks on the JSON response rather than an SSE frame.
	 * Absent when title gen was skipped, timed out, or already happened.
	 */
	title?: string;
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

/**
 * Sent before `done` when the conversation just had its title
 * auto-generated by the task model. The server emits this only when
 * the title resolved within the streaming-window budget; if title
 * generation runs slower, the SSE finishes without a title frame and
 * the new title appears on the next sidebar/conversation refetch.
 */
export interface StreamTitleEvent {
	type: 'title';
	title: string;
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
	| StreamTitleEvent
	| StreamDoneEvent
	| StreamErrorEvent;
