import { sqliteTable, text, integer, index, primaryKey } from 'drizzle-orm/sqlite-core';
// Relative import (not the $lib alias) on purpose: schema.ts is loaded
// outside the Vite build — by drizzle-kit, by the import-owui esbuild
// bundle, and by Playwright's e2e global-setup — none of which resolve
// $lib. Keep this module alias-free so it stays loadable everywhere.
import { MODEL_KINDS } from '../../types/api';

// --- users + sessions ----------------------------------------------------

export const users = sqliteTable('users', {
	id: text('id').primaryKey(),
	githubUserId: integer('github_user_id').notNull().unique(),
	githubUsername: text('github_username').notNull(),
	email: text('email'),
	displayName: text('display_name'),
	createdAt: integer('created_at').notNull(),
	lastLoginAt: integer('last_login_at'),
	// User-level preferences serialized as JSON. Null when the user has
	// never touched preferences (the parser fills in defaults). Schemaless
	// so adding new preferences isn't migration-gated; the parsing layer
	// validates each field defensively with fallbacks.
	preferencesJson: text('preferences_json')
});

export const sessions = sqliteTable('sessions', {
	id: text('id').primaryKey(),
	userId: text('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	expiresAt: integer('expires_at').notNull()
});

// Web Push subscriptions. One row per (user, browser-endpoint) pair: users
// may have several devices (laptop + phone + tablet), each producing its own
// endpoint URL from the push service. The endpoint is UNIQUE — resubscribing
// from the same device produces the same endpoint, so we upsert on it and
// reassign user_id if the device's account has changed. p256dh + auth are
// the per-endpoint encryption material the Web Push spec requires; the
// server uses them to encrypt payloads to the push service.
export const pushSubscriptions = sqliteTable(
	'push_subscriptions',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		endpoint: text('endpoint').notNull().unique(),
		p256dh: text('p256dh').notNull(),
		auth: text('auth').notNull(),
		// User-agent string at subscribe time, kept purely for a future
		// "your devices" UI ("Chrome on macOS — last seen 2 days ago").
		// Never used to gate behavior — endpoint is the identity.
		userAgent: text('user_agent'),
		createdAt: integer('created_at').notNull(),
		lastSeenAt: integer('last_seen_at').notNull()
	},
	(t) => [index('idx_push_subscriptions_user_id').on(t.userId)]
);

// --- conversations + messages (TREE-SHAPED) ------------------------------
//
// Conversations point to their current branch tip via active_leaf_message_id.
// Messages form a tree via parent_message_id (NULL only for the root user
// message of a conversation). The active branch is reconstructed by walking
// from active_leaf back to the root via parent pointers.
//
// v1 UX maintains a single linear branch. v2 will add sibling branches with
// no schema change: edit creates a new sibling and updates active_leaf.

export const conversations = sqliteTable(
	'conversations',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		title: text('title'),
		// Where the current title came from. Drives the title-gen state
		// machine: 'fallback' (default) is the first-N-chars preview set
		// at message-create time; 'ai' is set by the task model and is
		// allowed to overwrite a 'fallback'; 'user' means the user
		// manually renamed and locks against AI overwrite. The conditional
		// UPDATE in setConversationTitleIfFallback enforces the precedence.
		titleSource: text('title_source', { enum: ['fallback', 'ai', 'user'] })
			.notNull()
			.default('fallback'),
		endpointId: text('endpoint_id').notNull(),
		modelId: text('model_id').notNull(),
		// Snapshot of the model's `kind` at conversation-create time.
		// Lets the message-send dispatcher pick chat vs image vs video paths
		// without re-fetching upstream /v1/models on every send.
		modelKind: text('model_kind', { enum: MODEL_KINDS }),
		customModelId: text('custom_model_id').references(() => customModels.id, {
			onDelete: 'set null'
		}),
		systemPrompt: text('system_prompt'),
		// Sampling/generation params snapshotted from the custom model at
		// conversation-create time (or null when the user picked a base model
		// directly). Serialized as JSON so the v1 chat-only set
		// (temperature/top_p/max_tokens) can grow to per-modality params later
		// without another migration.
		parametersJson: text('parameters_json'),
		// Forward FK to messages.id; nullable until first message exists.
		// SQLite resolves the cyclic FK fine because both sides are nullable
		// at the right moments (active_leaf is null at conversation creation;
		// messages.parent_message_id is null only for the root message).
		// On message hard-delete, auto-null the pointer; app logic should
		// already have moved the active leaf elsewhere first.
		activeLeafMessageId: text('active_leaf_message_id').references((): any => messages.id, {
			onDelete: 'set null'
		}),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		archivedAt: integer('archived_at'),
		// Per-conversation opt-outs (see FEATURE_CATEGORIES in $lib/types/api).
		// JSON-serialized array of category keys, e.g. `["web"]`. Null/empty
		// means all features ON. Stored as a JSON array (not a column per
		// feature) so adding categories doesn't require a migration each time.
		disabledFeaturesJson: text('disabled_features')
	},
	(t) => [index('idx_conversations_user_updated').on(t.userId, t.updatedAt)]
);

export const messages = sqliteTable(
	'messages',
	{
		id: text('id').primaryKey(),
		conversationId: text('conversation_id')
			.notNull()
			.references(() => conversations.id, { onDelete: 'cascade' }),
		// Self-FK; NULL only for the conversation's root message.
		parentMessageId: text('parent_message_id'),
		role: text('role', { enum: ['system', 'user', 'assistant', 'tool'] }).notNull(),
		// Structured content parts (text, image, video, reasoning, future tool_call).
		// JSON-encoded; sidesteps a per-content-type table explosion.
		contentJson: text('content_json').notNull(),
		// Server-rendered cached HTML (markdown-it + shiki). Hot-path read concern.
		contentHtml: text('content_html'),
		// Reasoning text denormalized for quick separate display.
		reasoningText: text('reasoning_text'),
		finishReason: text('finish_reason'),
		modelUsed: text('model_used'),
		tokensIn: integer('tokens_in'),
		tokensOut: integer('tokens_out'),
		// Full upstream response (debug / troubleshoot).
		rawResponseJson: text('raw_response_json'),
		createdAt: integer('created_at').notNull()
	},
	(t) => [
		index('idx_messages_conv_parent').on(t.conversationId, t.parentMessageId),
		index('idx_messages_conv_created').on(t.conversationId, t.createdAt)
	]
);

// --- custom models (system-prompt presets) -------------------------------

export const customModels = sqliteTable('custom_models', {
	id: text('id').primaryKey(),
	userId: text('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	name: text('name').notNull(),
	description: text('description'),
	baseEndpointId: text('base_endpoint_id').notNull(),
	baseModelId: text('base_model_id').notNull(),
	systemPrompt: text('system_prompt'),
	parametersJson: text('parameters_json'),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull()
});

// --- media ----------------------------------------------------------------

export const media = sqliteTable(
	'media',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		// Relative to MEDIA_DIR; e.g. "ab/cd/abcd1234.png"
		storagePath: text('storage_path').notNull().unique(),
		contentType: text('content_type').notNull(),
		byteSize: integer('byte_size').notNull(),
		kind: text('kind', { enum: ['image', 'video'] }).notNull(),
		// Where this asset came from. 'generated' = produced by an upstream
		// model; 'uploaded' = sent by the user as a chat attachment. Same
		// storage + ref-counting; the gallery filters on this so user
		// uploads don't get attributed to a generation model.
		origin: text('origin', { enum: ['generated', 'uploaded'] })
			.notNull()
			.default('generated'),
		sourceEndpointId: text('source_endpoint_id'),
		sourceModel: text('source_model'),
		// promptExcerpt: a truncated (500 char) preview, used everywhere the
		// surrounding UI is space-constrained — gallery thumbnails, lightbox
		// caption strip. promptFull: the original untruncated prompt, used
		// when the user wants to act on the prompt as input (e.g. the
		// gallery's "Regenerate with this prompt" affordance, which would
		// silently corrupt long prompts if we only had the excerpt).
		// Population over migrations:
		//   - 0005 adds `prompt_full` and backfills it from `prompt_excerpt`
		//     (so legacy rows aren't NULL, but their stored "full" is
		//     actually truncated).
		//   - 0006 rehydrates from the user-message text part of the
		//     conversation that generated each media — recovering the real
		//     untruncated prompt for any legacy row whose source
		//     conversation still exists. Rows whose conversation was
		//     deleted before the library model shipped keep the 0005
		//     excerpt fallback.
		//   - Post-0005, the persister stores the real untruncated prompt
		//     directly when generating new media.
		// Net effect: rows generated after 0005 ship have a clean
		// `promptFull` always; legacy rows have one if-and-only-if their
		// conversation hasn't been deleted; the rest are stuck with the
		// excerpt as the best record we have.
		promptExcerpt: text('prompt_excerpt'),
		promptFull: text('prompt_full'),
		createdAt: integer('created_at').notNull(),
		refCount: integer('ref_count').notNull().default(0),
		// Set when ref_count drops to 0; used to compute grace-period expiry.
		unreferencedSince: integer('unreferenced_since'),
		// Set after grace period; bytes removed from disk, row preserved.
		hardDeletedAt: integer('hard_deleted_at')
	},
	(t) => [
		index('idx_media_user_created').on(t.userId, t.createdAt),
		index('idx_media_unreferenced').on(t.unreferencedSince)
	]
);

export const messageMedia = sqliteTable(
	'message_media',
	{
		messageId: text('message_id')
			.notNull()
			.references(() => messages.id, { onDelete: 'cascade' }),
		mediaId: text('media_id')
			.notNull()
			.references(() => media.id, { onDelete: 'cascade' })
	},
	(t) => [primaryKey({ columns: [t.messageId, t.mediaId] })]
);
