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

/**
 * Hard cap on a user-set conversation title. Enforced on the client as
 * the rename input's `maxlength` and on the server in renameConversation
 * — single-sourced here so the two halves can't drift apart.
 */
export const MAX_CONVERSATION_TITLE_LENGTH = 200;

/**
 * Feature-category keys for per-conversation opt-out. Two wirings share
 * the same `disabledFeatures` list:
 *
 *   1. Tools declare a `category` in their metadata; the chat handler
 *      filters out any tool whose category appears in the list before
 *      advertising tools to the model. (`web` works this way.)
 *   2. The messages handler also consults the list directly for non-tool
 *      gates — notably `personalization`, which suppresses the
 *      prefs-derived persona system prompt (name / About you / Custom
 *      instructions) at request time. When MCP and memory land, their
 *      tools will categorize under `personalization` too so a single
 *      switch seals every avenue that ships personal context to the
 *      model.
 *
 * Why category-level instead of per-tool? Privacy-sensitive opt-outs are
 * security boundaries, not UX groupings. Hiding `web_search` while
 * leaving `fetch_url` reachable is a false sense of security — the model
 * can trivially compose around it (e.g. `fetch_url`-ing a search-engine
 * URL directly). Both tools that touch the public web share the `web`
 * category so a single toggle seals the egress path.
 */
export const BUILTIN_FEATURE_CATEGORIES = ['web', 'personalization', 'code_interpreter'] as const;
export type BuiltinFeatureCategory = (typeof BUILTIN_FEATURE_CATEGORIES)[number];

/**
 * Per-conversation opt-out category. Open-ended at the type level because
 * dynamically-discovered MCP servers register categories like
 * `mcp:<server-id>` at startup. Built-in categories keep their narrow
 * types via {@link BuiltinFeatureCategory}; the `string & {}` intersection
 * preserves autocomplete on the built-ins while leaving the type open.
 */
export type FeatureCategory = BuiltinFeatureCategory | (string & {});

/**
 * Back-compat alias. Older call sites still iterate `FEATURE_CATEGORIES`
 * to render the built-in toggles; the dynamic surface (built-ins + live
 * MCP servers) is built at the UI layer.
 */
export const FEATURE_CATEGORIES = BUILTIN_FEATURE_CATEGORIES;

export const FEATURE_CATEGORY_LABELS: Record<
	BuiltinFeatureCategory,
	{ label: string; description: string }
> = {
	web: {
		label: 'Web access',
		description: 'Lets the assistant search the web and fetch pages.',
	},
	personalization: {
		label: 'Personalization',
		description:
			'Sends your name, About you, and Custom instructions from preferences as system context, and lets the assistant save and recall memories about you.',
	},
	code_interpreter: {
		label: 'Code interpreter',
		description:
			'Lets the assistant run Python in a sandboxed in-browser-style interpreter for compute, analysis, and plotting. Attached files become available; files Python writes appear as conversation attachments.',
	},
};

/**
 * Runtime guard for the *built-in* feature categories. MCP categories
 * (`mcp:<server-id>`) pass through validators directly as opaque strings;
 * use {@link isFeatureCategoryString} when the goal is to accept any
 * category form rather than narrow to a built-in.
 */
export function isBuiltinFeatureCategory(v: unknown): v is BuiltinFeatureCategory {
	return typeof v === 'string' && (BUILTIN_FEATURE_CATEGORIES as readonly string[]).includes(v);
}

/** Back-compat alias for the built-in narrow-check. */
export const isFeatureCategory = isBuiltinFeatureCategory;

/** Non-empty string guard — accepts both built-in and MCP-style categories. */
export function isFeatureCategoryString(v: unknown): v is FeatureCategory {
	return typeof v === 'string' && v.length > 0;
}

/**
 * One entry in the dynamic category list assembled by
 * `$lib/server/feature-categories.getAllFeatureCategoryLabels()`. Plain
 * data; built once per layout load and shipped to the client.
 */
export interface FeatureCategoryEntry {
	id: FeatureCategory;
	label: string;
	description: string;
	source: 'builtin' | 'mcp';
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
	/**
	 * Whether this model accepts native OpenAI tool-calling (the
	 * `tools` array + `tool_choice` in the request, `delta.tool_calls`
	 * in streaming responses, `role: 'tool'` for results).
	 *
	 * Resolution order (in `normalizeUpstreamModel`):
	 *   upstream.supports_tools  →  endpoint.supportsTools  →  false
	 *
	 * The OpenAI spec's `/v1/models` row doesn't carry this signal, so
	 * we use an additive extension (an aggregating bridge like
	 * openai-api-bridge populates it per backend model) with the
	 * per-endpoint config flag as a fallback for vendors that don't.
	 */
	supportsTools: boolean;
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
	/**
	 * Additive extension (openai-api-bridge convention): whether this
	 * model accepts native OpenAI tool-calling. Resolved against the
	 * endpoint-level `supports_tools` fallback in
	 * `normalizeUpstreamModel`. Vendors that don't set the field
	 * (the OpenAI spec doesn't require it) fall through to the
	 * endpoint config.
	 */
	supports_tools?: boolean | null;
}

// --- messages -----------------------------------------------------------
// Structured content parts. Additive shape: new variants slot in without
// breaking persisted rows since content_json is a freeform JSON column.
//
// `tool_call` parts live on `role: 'assistant'` rows (the model emitted
// one or more tool invocations); `tool_result` parts live on
// `role: 'tool'` rows (one per call, parented to the assistant message
// that emitted them). Display status is *derived* — look up the
// tool_result for a given toolCallId on the active branch — not stored,
// so the persisted shape can't drift from reality.

export type MessagePart =
	| { type: 'text'; text: string }
	| { type: 'image'; mediaId: string; alt?: string }
	| { type: 'video'; mediaId: string }
	| {
			// A non-image, non-video file attachment (xlsx, csv, pdf, json, ...).
			// Rendered as a download chip (filename + size + icon), not inline.
			// `filename` and `byteSize` are denormalized off the `media` row
			// at persist time so the renderer can draw the chip without a
			// per-message media lookup. The chip's download href still
			// resolves to /api/media/{mediaId}/content — `filename` is
			// purely the display label / `download` attribute hint.
			type: 'file';
			mediaId: string;
			filename: string;
			byteSize: number;
	  }
	| { type: 'reasoning'; text: string }
	| {
			type: 'tool_call';
			toolCallId: string;
			toolName: string;
			arguments: string;
			/**
			 * Optional pre-rendered HTML of the tool's "primary" argument
			 * when we know it's source code (today: `run_python`'s `code`
			 * parameter, server-rendered through the same shiki-backed
			 * markdown pipeline as assistant message bodies). The
			 * ToolCallBlock prefers this over the raw JSON args when
			 * present — a Python script reads better as syntax-highlighted
			 * Python than as `{"code": "import pandas as pd\\nimport ..."}`.
			 *
			 * Absent for non-code tools (clock, web_search, fetch_url, MCP
			 * tools whose args are configuration not code) and for older
			 * persisted rows that pre-date this field.
			 */
			argsHtml?: string;
	  }
	| {
			type: 'tool_result';
			toolCallId: string;
			result: string;
			isError?: boolean;
			/**
			 * Lifecycle state for MCP tool calls that require approval. Absent
			 * on existing rows and on all built-in tool results — the
			 * defensive default at read sites is `'completed'`. A
			 * `'pending_approval'` row carries an empty `result` until the
			 * user clicks Allow / Allow Always / Reject; the resume endpoint
			 * fills it in and flips the status.
			 */
			status?: 'pending_approval' | 'completed';
	  };

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
	/**
	 * Input image this message's generated media was edited / animated from
	 * (i2i edit, i2v) — the provenance recorded on the output media row.
	 * Populated by `getSiblingAssistants` for the split-attachments grid, so a
	 * reloaded fan-out keeps each result's input thumbnail + can regenerate it.
	 * Undefined elsewhere.
	 */
	sourceMediaId?: string | null;
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

/** Visual theme family. 'glyphstream' is the default Signature identity;
 *  'claude' / 'chatgpt' are alternate style personalities. Light vs dark
 *  within each follows the color scheme below. */
export type ThemeName = 'glyphstream' | 'claude' | 'chatgpt';

/** Light/dark override. 'system' follows prefers-color-scheme;
 *  'light' / 'dark' force that scheme regardless of the OS. */
export type ColorScheme = 'system' | 'light' | 'dark';

export interface UserPreferences {
	/**
	 * The three personalization fields below are combined server-side
	 * (via composePersonaSystemPrompt in user-preferences.ts) into a
	 * single system prompt and injected as the conversation's system
	 * message at request time — so edits here propagate to existing
	 * chats that don't have a custom-model preset or an explicit
	 * system prompt set. Gated per-conversation by the
	 * `personalization` entry in FEATURE_CATEGORIES.
	 *
	 * Splitting them gives users discoverable structure — "Name"
	 * prompts you to enter one, "About you" prompts you to think about
	 * standing context, "Custom instructions" prompts you to think
	 * about tone/style — rather than handing them a blank textarea
	 * with no scaffolding. All three are optional; empty fields are
	 * omitted from the composed prompt entirely (no "Name: (blank)"
	 * leaks).
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
	/** Selected visual theme family. Default 'glyphstream'. Mirrored into a
	 *  non-httpOnly `gs-theme` cookie so the server can apply it before first
	 *  paint (no flash); the DB pref stays the source of truth. */
	theme: ThemeName;
	/** Light/dark override. Default 'system'. Mirrored into a `gs-scheme`
	 *  cookie that the app.html inline script reads to set data-scheme before
	 *  first paint. */
	colorScheme: ColorScheme;
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
	/**
	 * Models pinned by the user. Stored in insertion order (most-recently
	 * starred goes to the end) and rendered both in the sidebar and as a
	 * "Favorites" section at the top of the model picker. Strings are
	 * picker-shape ids: `"<endpointId>::<upstreamId>"` for base models or
	 * `"custom::<customModelId>"` for saved presets. Unknown ids (a deleted
	 * preset, a removed endpoint) are silently filtered at render time —
	 * cheaper than gardening the stored list on every config edit.
	 */
	favoriteModels: string[];
	/**
	 * Namespaced MCP tool names (`mcp__<server>__<tool>`) the user has
	 * granted "always allow" — bypasses the per-tool-call approval prompt
	 * on subsequent calls. Default []. Cross-cutting permission storage
	 * shared with future skill / Open Terminal grants; revoke via the
	 * `/settings/permissions` page.
	 */
	trustedMcpTools: string[];
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
	/**
	 * Per-conversation opt-outs (see FEATURE_CATEGORIES). Always normalized
	 * to an array (never null) so consumers don't have to branch — an empty
	 * array means "all features on".
	 */
	disabledFeatures: FeatureCategory[];
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
	/**
	 * Initial per-conversation opt-outs (see FEATURE_CATEGORIES). Omit or
	 * pass an empty array for the default "all features on" experience.
	 * Unknown category strings are rejected with 400.
	 */
	disabledFeatures?: FeatureCategory[];
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
	/** Per-preset starting state for the per-conversation feature toggles
	 *  — the composer seeds its `disabledFeatures` from this when the user
	 *  picks the preset. Empty array means "all features on", same as the
	 *  global default. */
	defaultDisabledFeatures: FeatureCategory[];
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
	defaultDisabledFeatures?: FeatureCategory[];
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
	/**
	 * "Multi-model fan-out branch" — when true, this request is one of N
	 * concurrent generations sharing the user message at `parentMessageId`
	 * (created once by POST .../messages/prepare). The server does NOT create
	 * a user message, does NOT advance the conversation's active_leaf (the N
	 * siblings stay under the shared user message until the user picks one),
	 * and treats `modelId` as a TRANSIENT override for this branch only — it
	 * is recorded per-message via `modelUsed` and never rewrites the
	 * conversation's stored model. `text` / `attachedMediaIds` are ignored
	 * (derived from the shared user message, like retry). Single-iteration:
	 * tool loops aren't supported on a fan-out branch.
	 */
	fanoutBranch?: boolean;
	/**
	 * Split-attachments: restrict THIS fan-out branch to a subset (typically
	 * one) of the shared user message's attached images as its image input, so
	 * N attached images fan out into N independent edits / animations. Only ids
	 * actually attached to the parent are honored. Ignored unless `fanoutBranch`.
	 */
	inputMediaIds?: string[];
}

/**
 * POST /api/conversations/:id/messages/prepare request — creates the shared
 * user message for a multi-model fan-out without dispatching. Mirrors the
 * user-message fields of `SendMessageRequest` (no model fields: each branch
 * carries its own model).
 */
export interface PrepareFanoutRequest {
	text: string;
	attachedMediaIds?: string[];
	parentMessageId?: string;
	editedMessageId?: string;
}

/** POST .../messages/prepare response — the persisted shared user message
 *  the client then parents each fan-out branch to. */
export interface PrepareFanoutResponse {
	userMessage: ChatMessage;
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

/**
 * Sent before any generation events when the request had to wait for a
 * per-endpoint concurrency slot (the endpoint's `max_concurrent` was full).
 * The in-flight bubble shows a "Queued…" state until the first real event
 * (`start` / `text` / `progress`) arrives once the slot is granted. May be
 * emitted once; absent entirely when the slot was free immediately.
 */
export interface StreamQueuedEvent {
	type: 'queued';
	/** How many other queued generations are ahead of this one. */
	ahead: number;
}

// --- tool-call streaming events -----------------------------------------
//
// Server emits these inline between text/reasoning events as the upstream
// streams its tool invocations. The client builds an in-flight tool-call
// map keyed by toolCallId so each call's UI block fills in
// progressively: start → args streaming → executing (we're running the
// tool) → result (the tool returned).

/** First sighting of a given tool_call from the upstream stream. */
export interface StreamToolCallStartEvent {
	type: 'tool_call_start';
	toolCallId: string;
	toolName: string;
}

/** Incremental chunk of the tool_call's `arguments` JSON. Multiple
 *  events arrive per call; concatenate into the final args string. */
export interface StreamToolCallArgsDeltaEvent {
	type: 'tool_call_args_delta';
	toolCallId: string;
	argumentsDelta: string;
}

/** The server has started running this tool's `execute()`. UI flips the
 *  block from "args streaming" to "executing" (typically with a spinner). */
export interface StreamToolCallExecutingEvent {
	type: 'tool_call_executing';
	toolCallId: string;
}

/** The tool finished. UI shows the result (or error). The persisted
 *  `role: 'tool'` row carries the same content; this event is just the
 *  push-notification version for the in-flight UI. */
export interface StreamToolCallResultEvent {
	type: 'tool_call_result';
	toolCallId: string;
	result: string;
	isError: boolean;
}

/**
 * The server skipped this tool because the user hasn't granted it
 * "always allow" yet. UI renders an inline approval prompt and disables
 * the composer until the user posts a decision to the resume endpoint;
 * the relay-loop halts (no further upstream call) until that resume
 * arrives.
 */
export interface StreamToolPendingApprovalEvent {
	type: 'tool_pending_approval';
	toolCallId: string;
	toolName: string;
	displayLabel?: string;
	category?: string;
	args: string;
}

export type StreamEvent =
	| StreamStartEvent
	| StreamTextEvent
	| StreamReasoningEvent
	| StreamProgressEvent
	| StreamTitleEvent
	| StreamDoneEvent
	| StreamErrorEvent
	| StreamQueuedEvent
	| StreamToolCallStartEvent
	| StreamToolCallArgsDeltaEvent
	| StreamToolCallExecutingEvent
	| StreamToolCallResultEvent
	| StreamToolPendingApprovalEvent;

/** A saved per-user memory, as returned by `GET /api/user/memories` and
 *  injected into the persona system prompt. Body shape matches the
 *  `memories` table minus the (server-only) embedding columns. */
export interface Memory {
	id: string;
	content: string;
	createdAt: number;
	updatedAt: number;
}
