import {
	sqliteTable,
	text,
	integer,
	blob,
	index,
	primaryKey,
	uniqueIndex,
} from 'drizzle-orm/sqlite-core';
// Relative import (not the $lib alias) on purpose: schema.ts is loaded
// outside the Vite build — by drizzle-kit, by the import-owui esbuild
// bundle, and by Playwright's e2e global-setup — none of which resolve
// $lib. Keep this module alias-free so it stays loadable everywhere.
import { MODEL_KINDS } from '../../types/api';

// --- users + sessions ----------------------------------------------------

export const users = sqliteTable('users', {
	id: text('id').primaryKey(),
	email: text('email'),
	displayName: text('display_name'),
	createdAt: integer('created_at').notNull(),
	lastLoginAt: integer('last_login_at'),
	// Operator-disabled flag — when non-null, this user's sessions are
	// invalidated at the next request and new logins (via any method) are
	// refused with 403. Replaces the GitHub-numeric-ID allowlist's
	// revocation semantics: there's no list to maintain in sync with
	// reality; toggling this column is the single source of truth.
	disabledAt: integer('disabled_at'),
	// User-level preferences serialized as JSON. Null when the user has
	// never touched preferences (the parser fills in defaults). Schemaless
	// so adding new preferences isn't migration-gated; the parsing layer
	// validates each field defensively with fallbacks.
	preferencesJson: text('preferences_json'),
});

// OAuth provider bindings. 1-to-many off `users` — a single user can
// have zero, one, or several OAuth accounts (GitHub today; Google,
// GitLab, etc. in the future), plus zero or more passkeys. The login
// callback looks up by (provider, external_id); binding a new provider
// happens only via the /setup wizard or the Settings → Security
// "Link …" flow (no auto-create-on-first-login).
//
// `external_id` is text rather than integer because GitHub gives
// numeric ids but other providers (Google, generic OIDC) give string
// ids; storing them uniformly avoids a per-provider column choice.
//
// `external_username` and `external_email` mirror the provider's view
// of the operator's identity at last sync time — useful for the
// "linked as @octocat" label in settings, and as fallback for the
// user-level `users.display_name` / `users.email` at create time.
export const oauthAccounts = sqliteTable(
	'oauth_accounts',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		provider: text('provider').notNull(),
		externalId: text('external_id').notNull(),
		externalUsername: text('external_username'),
		externalEmail: text('external_email'),
		createdAt: integer('created_at').notNull(),
		lastSyncedAt: integer('last_synced_at'),
	},
	(t) => [
		uniqueIndex('uq_oauth_accounts_provider_external').on(t.provider, t.externalId),
		index('idx_oauth_accounts_user_id').on(t.userId),
	],
);

export const sessions = sqliteTable('sessions', {
	id: text('id').primaryKey(),
	userId: text('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	expiresAt: integer('expires_at').notNull(),
});

// WebAuthn / passkey credentials. Bound to an existing user (always
// bootstrapped via GitHub OAuth first), so this table only ever holds
// additional sign-in methods — it is never the source of identity.
// `id` is the credential ID returned by the authenticator (base64url,
// globally unique per spec) so it's safe as the PK and as the lookup
// key during usernameless discoverable-credential login. `public_key`
// is COSE bytes from @simplewebauthn/server; stored as BLOB to avoid
// round-tripping through base64 on every verify. `counter` is the
// signature counter — bumped atomically with `last_used_at` after a
// successful login; the verify path also clone-detects against the
// stored value (when stored > 0; some authenticators always return 0).
// `backed_up` / `device_type` come from the registration response and
// drive a "Synced" indicator in settings.
export const passkeyCredentials = sqliteTable(
	'passkey_credentials',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		publicKey: blob('public_key').notNull(),
		counter: integer('counter').notNull().default(0),
		transportsJson: text('transports_json'),
		backedUp: integer('backed_up', { mode: 'boolean' }).notNull().default(false),
		deviceType: text('device_type', { enum: ['singleDevice', 'multiDevice'] }).notNull(),
		name: text('name'),
		createdAt: integer('created_at').notNull(),
		lastUsedAt: integer('last_used_at'),
	},
	(t) => [index('idx_passkey_credentials_user_id').on(t.userId)],
);

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
		endpoint: text('endpoint').notNull(),
		p256dh: text('p256dh').notNull(),
		auth: text('auth').notNull(),
		// User-agent string at subscribe time, kept purely for a future
		// "your devices" UI ("Chrome on macOS — last seen 2 days ago").
		// Never used to gate behavior — endpoint is the identity.
		userAgent: text('user_agent'),
		createdAt: integer('created_at').notNull(),
		lastSeenAt: integer('last_seen_at').notNull(),
	},
	(t) => [
		// Explicit uniqueIndex (not column `.unique()`) so drizzle-kit v1 emits a
		// standalone UNIQUE INDEX matching the existing DB object — column
		// `.unique()` now generates an inline table constraint, which would
		// force a no-op table rebuild on upgrade. Name pinned to the original
		// auto-generated one.
		uniqueIndex('push_subscriptions_endpoint_unique').on(t.endpoint),
		index('idx_push_subscriptions_user_id').on(t.userId),
	],
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
			onDelete: 'set null',
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
			onDelete: 'set null',
		}),
		// When set, this conversation has an UNRESOLVED multi-model fan-out:
		// the leaf is pinned at this user message while its N sibling assistant
		// responses await the user's pick (text) or pruning (image). Set by
		// .../messages/prepare; cleared by selectBranch (pick / dismiss /
		// continue), truncateAtMessage, leaf-advancing appendMessage, and
		// deleteBranch when the anchor is deleted. Lets the page rehydrate the
		// compare grid after a reload without guessing from sibling counts.
		// NOTE: this column was added via ALTER TABLE (migration 0019), which
		// drizzle-kit can't emit an ON DELETE clause on — so the live FK is NO
		// ACTION, not the `set null` declared here. The app therefore clears
		// this reference explicitly in the query paths above rather than relying
		// on the FK; do not assume the DB will null it for you.
		fanoutParentMessageId: text('fanout_parent_message_id').references((): any => messages.id, {
			onDelete: 'set null',
		}),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		archivedAt: integer('archived_at'),
		// Per-conversation opt-outs (see FEATURE_CATEGORIES in $lib/types/api).
		// JSON-serialized array of category keys, e.g. `["web"]`. Null/empty
		// means all features ON. Stored as a JSON array (not a column per
		// feature) so adding categories doesn't require a migration each time.
		disabledFeaturesJson: text('disabled_features'),
	},
	(t) => [index('idx_conversations_user_updated').on(t.userId, t.updatedAt)],
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
		// Generation wall-time in ms. For text: first→last content token
		// (excludes time-to-first-token, and tool gaps fall between rows).
		// For image/video: slot-acquired→persisted. Null on legacy rows and
		// when no content was produced. The client derives tok/s from this
		// plus `tokens_out`.
		genMs: integer('gen_ms'),
		// Full upstream response (debug / troubleshoot).
		rawResponseJson: text('raw_response_json'),
		createdAt: integer('created_at').notNull(),
	},
	(t) => [
		index('idx_messages_conv_parent').on(t.conversationId, t.parentMessageId),
		index('idx_messages_conv_created').on(t.conversationId, t.createdAt),
	],
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
	// Per-preset starting state for the per-conversation feature toggles.
	// Same JSON-array shape as `conversations.disabled_features`. The
	// composer seeds its `disabledFeatures` state from this when the user
	// picks the preset, so the toggle UI reflects what the conversation
	// will be created with (the user can still override before sending).
	// NULL / empty means all features default ON, same as the global
	// default. Useful when a preset's purpose doesn't fit one of the
	// gates — e.g. a code-review preset that shouldn't pull in personal
	// context, or a URL-summarizer where web access is redundant.
	defaultDisabledFeaturesJson: text('default_disabled_features'),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull(),
});

// --- memories -------------------------------------------------------------
//
// Per-user standing facts the model has chosen to remember (preferences,
// identity, durable interests). Browse-mode MVP: every row's `content` gets
// inlined into the system prompt when the conversation's `personalization`
// feature category is enabled, so the model always has the full index.
// Write path is tool-calls (save_memory / update_memory / forget_memory);
// the management UI is view + delete only.
//
// `embedding` + `embeddingModel` are the phase-2 hook: NULL means "not yet
// embedded", a future backfill populates them, and the injection branch
// then switches between body-inlining and a recall-tool hint based on
// endpoint capability + memory count. No schema migration when that lands.

export const memories = sqliteTable(
	'memories',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		content: text('content').notNull(),
		embedding: blob('embedding'),
		embeddingModel: text('embedding_model'),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
	},
	(t) => [index('idx_memories_user_created').on(t.userId, t.createdAt)],
);

// --- skills ---------------------------------------------------------------
//
// Per-user agent-skill bundles (agentskills.io spec). Each skill is a
// multi-file *package* stored on disk verbatim (SKILL.md + any resources)
// under `${SKILLS_DIR}/<userId>/<name>/`; this row is the lightweight
// catalog index. `name` + `description` are denormalized from the SKILL.md
// frontmatter at import time so the Tier-1 catalog injected into every
// request's system prompt is a cheap DB read, not a filesystem walk. The
// body and bundled resources live only on disk, read on activation
// (activate_skill / read_skill_file). `storagePath` is the relative dir
// (`<userId>/<name>`); renaming a skill moves the directory and updates it.
//
// `unique(userId, name)` is load-bearing: activate_skill resolves a skill by
// name, the on-disk directory is named after the skill, and the spec requires
// the frontmatter `name` to match the parent directory — so names must be
// unique within a user. `enabled` gates a skill out of the catalog + the
// activation enum without deleting it.

export const skills = sqliteTable(
	'skills',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		description: text('description').notNull(),
		storagePath: text('storage_path').notNull(),
		enabled: integer('enabled').notNull().default(1),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
	},
	(t) => [
		uniqueIndex('uq_skills_user_name').on(t.userId, t.name),
		index('idx_skills_user_created').on(t.userId, t.createdAt),
	],
);

// --- media ----------------------------------------------------------------

export const media = sqliteTable(
	'media',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		// Relative to MEDIA_DIR; e.g. "ab/cd/abcd1234.png"
		storagePath: text('storage_path').notNull(),
		contentType: text('content_type').notNull(),
		byteSize: integer('byte_size').notNull(),
		// 'file' covers anything that isn't an image or video — xlsx, csv,
		// pdf, json, txt, etc. — which the user can attach as analyzable
		// input for the code interpreter (or for a text model to reason
		// about the filename). Gallery queries default-filter to
		// ('image', 'video') so file kinds never leak into the visual
		// library UI; see `listMediaForUser`.
		kind: text('kind', { enum: ['image', 'video', 'file'] }).notNull(),
		// Original filename from the upload (e.g. "Q4-budget.xlsx"). Null
		// for legacy rows and for AI-generated images/videos where the
		// concept doesn't apply. Used by the code interpreter to mount
		// the file under its original name in the worker's virtual FS,
		// and by the attachment-chip UI as the display label.
		originalFilename: text('original_filename'),
		// Where this asset came from. 'generated' = produced by an upstream
		// model; 'uploaded' = sent by the user as a chat attachment. Same
		// storage + ref-counting; the gallery filters on this so user
		// uploads don't get attributed to a generation model.
		origin: text('origin', { enum: ['generated', 'uploaded'] })
			.notNull()
			.default('generated'),
		sourceEndpointId: text('source_endpoint_id'),
		sourceModel: text('source_model'),
		// For a generated asset that edited / animated an input image
		// (image-to-image edit, image-to-video), the media id of that input.
		// Drives the multi-model "split attachments" grid (each result labelled
		// by its source thumbnail) and survives a reload, so a recovered split
		// fan-out keeps its input pairing + can regenerate the right input.
		// Null for text-to-image / uploads / legacy rows. Added via ALTER TABLE
		// (migration 0020), so the live FK is NO ACTION, not the `set null`
		// declared here (drizzle-kit can't emit ON DELETE on ADD COLUMN). In
		// practice this never bites: media rows are only ever soft-deleted (the
		// purger clears bytes + sets hard_deleted_at, never DELETEs the row), so
		// the source row a generated asset points at always survives.
		sourceMediaId: text('source_media_id').references((): any => media.id, {
			onDelete: 'set null',
		}),
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
		hardDeletedAt: integer('hard_deleted_at'),
	},
	(t) => [
		// Explicit uniqueIndex (not column `.unique()`) — see the note on
		// push_subscriptions.endpoint. Name pinned to the original auto-name.
		uniqueIndex('media_storage_path_unique').on(t.storagePath),
		index('idx_media_user_created').on(t.userId, t.createdAt),
		// Covers the purger's WHERE — unreferenced_since <= cutoff AND
		// hard_deleted_at IS NULL AND origin = 'uploaded'. Putting the
		// range column last lets SQLite use index-only equality probes on
		// origin + hardDeletedAt before walking unreferenced_since rows.
		index('idx_media_unreferenced').on(t.origin, t.hardDeletedAt, t.unreferencedSince),
	],
);

export const messageMedia = sqliteTable(
	'message_media',
	{
		messageId: text('message_id')
			.notNull()
			.references(() => messages.id, { onDelete: 'cascade' }),
		mediaId: text('media_id')
			.notNull()
			.references(() => media.id, { onDelete: 'cascade' }),
	},
	(t) => [
		primaryKey({ columns: [t.messageId, t.mediaId] }),
		// The PK covers (message_id, media_id) lookups, but the reverse
		// direction — "which messages reference this media?" — is hot too:
		// listConversationsForMedia, countOrphanMediaInConversation, and the
		// orphan-detection passes all filter on media_id alone. Without this
		// index, those queries scan the whole join table.
		index('idx_message_media_media_id').on(t.mediaId),
	],
);
