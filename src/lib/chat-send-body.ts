/**
 * Build the JSON request body for POST /api/conversations/:id/messages.
 *
 * Lives outside the chat page mostly so the wire body can be tested in
 * isolation — but it also fixes a real duplication / drift hazard: the
 * page previously constructed this body inline in two places
 * (`sendStreaming` and `sendImageGeneration`), and the next caller that
 * added a new `SendOptions` field had to remember to update both.
 * Centralizing here forces the contract through one code path, which
 * is exactly the kind of footgun that let the `editedMessageId` field
 * silently fall off the wire after the server-side edit-routing
 * refactor in commit 962cfb3 (server handled the field correctly,
 * client never sent it, edits silently appended-instead-of-branched).
 *
 * Three modes:
 *   - Retry (regenerateFromMessageId set): server reuses the existing
 *     user message and creates a new assistant sibling. text and
 *     attachments are intentionally omitted — the route handler
 *     wouldn't read them anyway and including them is misleading.
 *   - Edit (editedMessageId set): the new user message becomes a
 *     sibling of the edited one. Server looks up the edited message's
 *     parent and uses that as the new sibling's parent — including
 *     the null case for root edits.
 *   - Plain send (neither set): append to the conversation's active
 *     leaf. parentMessageId is the legacy override that fell out of
 *     use when saveEdit switched to editedMessageId, kept supported
 *     for any future caller that's already resolved the parent
 *     directly.
 *
 * Output is typed as `Record<string, unknown>` rather than
 * `SendMessageRequest` because: (a) modelKind on the chat page is
 * `ModelKind | null` but the request type doesn't model the null
 * case, and (b) the retry shape legitimately omits required fields
 * that the server tolerates as missing on retry. Loose-typed JSON at
 * the boundary, strict types where they buy clarity.
 */

import type { ModelKind } from './types/api';

export interface SendOptions {
	/**
	 * Legacy direct-parent override — caller has already resolved
	 * the parent message id and wants it used as-is. Superseded by
	 * `editedMessageId` for the edit flow (cleaner contract, handles
	 * null parents correctly), kept here for any future caller that
	 * needs to branch off an arbitrary parent without referencing a
	 * specific edited message.
	 */
	parentMessageId?: string;
	/**
	 * Edit flow: server treats the new user message as a sibling of
	 * the message with this id, copying its parent_message_id onto
	 * the new row. Handles root edits (where the parent is null)
	 * correctly — the older parentMessageId path silently dropped
	 * null on the wire.
	 */
	editedMessageId?: string;
	/**
	 * Retry flow: server generates a new assistant sibling of the
	 * message with this id, reusing the user message that prompted
	 * it. text + attachedMediaIds are ignored in this mode.
	 */
	retryFromMessageId?: string;
}

export interface BuildBodyInput {
	text: string;
	attachedMediaIds: string[];
	modelId: string;
	modelKind: ModelKind | null;
	options?: SendOptions;
}

export function buildSendRequestBody(input: BuildBodyInput): Record<string, unknown> {
	const opts = input.options ?? {};

	if (opts.retryFromMessageId) {
		return {
			regenerateFromMessageId: opts.retryFromMessageId,
			modelId: input.modelId,
			modelKind: input.modelKind,
		};
	}

	return {
		text: input.text,
		attachedMediaIds: input.attachedMediaIds,
		modelId: input.modelId,
		modelKind: input.modelKind,
		...(opts.editedMessageId ? { editedMessageId: opts.editedMessageId } : {}),
		...(opts.parentMessageId ? { parentMessageId: opts.parentMessageId } : {}),
	};
}

/**
 * Body for one branch of a multi-model fan-out. The shared user message was
 * already created by POST .../messages/prepare; this branch streams a sibling
 * assistant response under it using `modelId` as a TRANSIENT override (the
 * server records it per-message via modelUsed and never rewrites the
 * conversation's stored model). text/attachments are omitted — the server
 * derives the prompt from the shared user message, like retry.
 */
export function buildFanoutBranchBody(input: {
	parentMessageId: string;
	modelId: string;
	modelKind: ModelKind | null;
	/** Split-attachments: restrict this branch to one of the shared message's
	 *  images. Omitted for a non-split branch (derives all attachments). */
	inputMediaId?: string | null;
	/** Regenerate (re-roll in place): the sibling this branch replaces, so
	 *  recovery shadows the old-but-not-yet-deleted sibling during the re-roll. */
	replacesMessageId?: string | null;
}): Record<string, unknown> {
	return {
		fanoutBranch: true,
		parentMessageId: input.parentMessageId,
		modelId: input.modelId,
		modelKind: input.modelKind,
		...(input.inputMediaId ? { inputMediaIds: [input.inputMediaId] } : {}),
		...(input.replacesMessageId ? { replacesMessageId: input.replacesMessageId } : {}),
	};
}
