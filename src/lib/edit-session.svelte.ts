/**
 * The inline message-edit session.
 *
 * When a session is open the target message's bubble re-renders as an in-place
 * editor and the bottom composer is hidden entirely, so it's unambiguous which
 * message you're editing. Saving sends a new sibling of the edited message;
 * cancelling discards.
 *
 * Extracted from the chat page, where it was three pieces of state plus an
 * `AttachmentStore`, opened and cleared from four different places (begin,
 * cancel, save, and the conversation-switch reset). Every one of those had to
 * clear all of them, by hand — a clear-site that forgot one would leave the page
 * with a stale editor target and no composer, which is unrecoverable without a
 * reload. `#reset()` is now the only way to close a session.
 *
 * Edit state is deliberately separate from the composer's own text so a
 * half-typed draft isn't clobbered by opening an editor.
 *
 * ## Why there is no `parentId` here
 *
 * The page used to track the edited message's `parentMessageId` and put it on
 * the wire. It doesn't anymore: the server resolves the parent from
 * `editedMessageId` and copies it onto the new sibling — including the null case
 * (editing the conversation's root), which the old client-resolved approach
 * silently dropped, causing root edits to append instead of branch. The field
 * outlived that change as dead state; it isn't reintroduced here.
 */

import { AttachmentStore } from './attachments.svelte';
import { partsToText } from './message-parts';
import type { ChatMessage } from './types/api';

export interface EditSessionDeps {
	/** True while a turn is generating — editing is blocked. */
	generating(): boolean;
	/**
	 * Commit the edit as a new sibling of `editedMessageId`. The page routes
	 * this to its turn controller, which owns the in-flight bubble and the
	 * optimistic swap.
	 */
	send(text: string, attachedMediaIds: string[], editedMessageId: string): Promise<void>;
}

export class EditSession {
	#deps: EditSessionDeps;

	/** The message being edited, or null when no session is open. Drives both
	 *  the inline editor and the composer's visibility. */
	messageId = $state<string | null>(null);
	/** Working copy of the message text. */
	text = $state('');
	/** Attachments for the edited message, seeded from its existing images. */
	readonly attachments = new AttachmentStore();

	constructor(deps: EditSessionDeps) {
		this.#deps = deps;
	}

	/** True while an edit session is open. */
	get active(): boolean {
		return this.messageId !== null;
	}

	/** Open a session on `m`, seeding the text and its existing image attachments. */
	begin(m: ChatMessage): void {
		if (this.#deps.generating()) return;
		this.text = partsToText(m.parts);
		this.attachments.clear();
		for (const p of m.parts) {
			if (p.type === 'image') this.attachments.attachExisting(p.mediaId);
		}
		this.messageId = m.id;
	}

	/** Discard the session without sending. */
	cancel(): void {
		this.#reset();
	}

	/**
	 * Commit the edit. Resets the session BEFORE sending: the turn controller
	 * does its own UI work (in-flight bubble, optimistic placeholder swap on
	 * `start`) that shouldn't compete with a still-mounted editor.
	 */
	async save(): Promise<void> {
		const text = this.text.trim();
		const editedId = this.messageId;
		if (!editedId) return;
		if ((!text && this.attachments.items.length === 0) || this.#deps.generating()) return;
		if (this.attachments.isBusy) return;
		const attachedMediaIds = this.attachments.readyMediaIds();
		this.#reset();
		await this.#deps.send(text, attachedMediaIds, editedId);
	}

	/**
	 * Close any open session — called on a conversation switch. The page's
	 * component is reused across switches, so a session left open would target a
	 * message that doesn't exist in the new conversation, hiding the composer
	 * with no inline editor to replace it and leaving no way to type.
	 */
	closeForConversationSwitch(): void {
		this.#reset();
	}

	/** Release the attachment store's object URLs. */
	destroy(): void {
		this.attachments.destroy();
	}

	/** The single close path — the four callers used to each clear every field
	 *  by hand, and forgetting one wedged the composer. */
	#reset(): void {
		this.messageId = null;
		this.text = '';
		this.attachments.clear();
	}
}
