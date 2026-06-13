/**
 * Persist a new user message (the anchor an assistant turn hangs off of),
 * shared by the messages POST handler and the fan-out /prepare endpoint.
 *
 * Validates attached media ownership, resolves the parent (edit / explicit
 * parent / active-leaf append via `resolveParentForUserMessage`), builds the
 * text-then-attachments part list, links the media, and seeds a preview
 * title on the first exchange. Throws SvelteKit `error()` on bad input —
 * both callers are request handlers, so the 4xx surfaces cleanly.
 */

import { error } from '@sveltejs/kit';
import { setConversationTitle } from '$lib/server/db/queries/conversations';
import { getMediaForUser, linkMessageMedia } from '$lib/server/db/queries/media';
import { appendMessage, resolveParentForUserMessage } from '$lib/server/db/queries/messages';
import type { ChatMessage, MessagePart } from '$lib/types/api';

const TITLE_PREVIEW_MAX = 60;

export interface CreateUserMessageInput {
	conversationId: string;
	userId: string;
	/** Already trimmed. */
	text: string;
	attachedMediaIds: string[];
	editedMessageId?: string;
	parentMessageId?: string;
	activeLeafMessageId: string | null;
	/** The conversation's current title; when empty a preview title is seeded
	 *  from the first text so the sidebar isn't blank before the task model's
	 *  title lands. */
	existingTitle: string | null;
}

export function createUserMessage(input: CreateUserMessageInput): ChatMessage {
	// Validate every attached media id belongs to this user and isn't
	// hard-deleted before we persist anything — so a tampered request can't
	// land an unowned-media reference on a real conversation row. Stash the
	// loaded rows (keyed by id) so the part-building step can route by kind
	// without a second DB roundtrip.
	const attachedMediaById = new Map<
		string,
		{ kind: 'image' | 'video' | 'file'; byteSize: number; originalFilename: string | null }
	>();
	for (const mid of input.attachedMediaIds) {
		const m = getMediaForUser(mid, input.userId);
		if (!m || m.hardDeletedAt !== null) {
			throw error(400, `Attached media "${mid}" not found`);
		}
		attachedMediaById.set(mid, {
			kind: m.kind,
			byteSize: m.byteSize,
			originalFilename: m.originalFilename,
		});
	}

	// Resolve the parent for the new user message. The helper returns a
	// discriminated result so we can map misses to the right 400 without
	// coupling it to SvelteKit's error machinery (keeps it unit-testable).
	const resolved = resolveParentForUserMessage({
		conversationId: input.conversationId,
		activeLeafMessageId: input.activeLeafMessageId,
		editedMessageId: input.editedMessageId,
		parentMessageId: input.parentMessageId,
	});
	if (!resolved.ok) {
		const field =
			resolved.reason === 'edited-message-not-found' ? 'editedMessageId' : 'parentMessageId';
		throw error(400, `${field} "${resolved.id}" not found`);
	}

	// Persist user message + auto-title BEFORE any upstream call so even if the
	// upstream fails the user's input is preserved on the active branch.
	// Image/video/file parts come after the text part so the UI renders
	// text-then-attachments. File kinds get a download-chip part with
	// denormalized filename + size so the renderer needs no media lookup.
	const userParts: MessagePart[] = [];
	if (input.text) userParts.push({ type: 'text', text: input.text });
	for (const mid of input.attachedMediaIds) {
		const m = attachedMediaById.get(mid)!;
		if (m.kind === 'image') {
			userParts.push({ type: 'image', mediaId: mid });
		} else if (m.kind === 'video') {
			userParts.push({ type: 'video', mediaId: mid });
		} else {
			userParts.push({
				type: 'file',
				mediaId: mid,
				// Fall back to the media id when an upload pre-dates the
				// original_filename column (legacy rows) — at least the chip
				// won't render with an empty label.
				filename: m.originalFilename ?? mid,
				byteSize: m.byteSize,
			});
		}
	}
	const userMessage = appendMessage({
		conversationId: input.conversationId,
		parentMessageId: resolved.parentMessageId,
		role: 'user',
		parts: userParts,
	});
	for (const mid of input.attachedMediaIds) {
		linkMessageMedia(userMessage.id, mid);
	}
	if (!input.existingTitle && input.text) {
		const preview =
			input.text.length > TITLE_PREVIEW_MAX
				? input.text.slice(0, TITLE_PREVIEW_MAX - 1) + '…'
				: input.text;
		setConversationTitle(input.conversationId, input.userId, preview);
	}
	return userMessage;
}
