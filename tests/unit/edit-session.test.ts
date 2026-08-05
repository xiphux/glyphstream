/**
 * Unit tests for the extracted inline-edit session.
 *
 * The invariant worth holding is that a session has exactly ONE close path.
 * Inline in the chat page, four call sites (begin-over, cancel, save, and the
 * conversation-switch reset) each cleared the three pieces of state by hand, and
 * a site that forgot one would leave a stale editor target with the composer
 * unmounted — no way to type, unrecoverable without a reload. These tests assert
 * every exit leaves the session fully closed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const attachmentInstances = vi.hoisted(() => [] as MockStore[]);

class MockStore {
	items: { mediaId: string }[] = [];
	isBusy = false;
	cleared = 0;
	destroyed = 0;
	attached: string[] = [];
	clear() {
		this.items = [];
		this.cleared += 1;
	}
	destroy() {
		this.destroyed += 1;
	}
	attachExisting(id: string) {
		this.attached.push(id);
		this.items.push({ mediaId: id });
	}
	readyMediaIds() {
		return this.items.map((i) => i.mediaId);
	}
}

vi.mock('$lib/attachments.svelte', () => ({
	AttachmentStore: class {
		constructor() {
			const s = new MockStore();
			attachmentInstances.push(s);
			return s as unknown as object;
		}
	},
}));

import { EditSession, type EditSessionDeps } from '$lib/edit-session.svelte';
import type { ChatMessage } from '$lib/types/api';

function msg(overrides: Partial<ChatMessage> = {}): ChatMessage {
	return {
		id: 'm1',
		role: 'user',
		parts: [{ type: 'text', text: 'hello world' }],
		createdAt: 1,
		...overrides,
	} as ChatMessage;
}

function make(overrides: Partial<EditSessionDeps> = {}) {
	const sends: { text: string; mediaIds: string[]; editedMessageId: string }[] = [];
	const state = { generating: false };
	const session = new EditSession({
		generating: () => state.generating,
		send: async (text, mediaIds, editedMessageId) => {
			sends.push({ text, mediaIds, editedMessageId });
		},
		...overrides,
	});
	const store = attachmentInstances[attachmentInstances.length - 1];
	return { session, sends, state, store };
}

/** Every field a close must reset. */
function expectClosed(session: EditSession) {
	expect(session.messageId).toBeNull();
	expect(session.text).toBe('');
	expect(session.active).toBe(false);
}

beforeEach(() => {
	attachmentInstances.length = 0;
});

describe('opening a session', () => {
	it('seeds the text and the existing image attachments', () => {
		const { session, store } = make();
		session.begin(
			msg({
				parts: [
					{ type: 'text', text: 'a caption' },
					{ type: 'image', mediaId: 'img-1' },
					{ type: 'image', mediaId: 'img-2' },
				],
			}),
		);

		expect(session.active).toBe(true);
		expect(session.messageId).toBe('m1');
		expect(session.text).toBe('a caption');
		expect(store.attached).toEqual(['img-1', 'img-2']);
	});

	it('ignores non-text, non-image parts when seeding the text', () => {
		const { session } = make();
		session.begin(
			msg({
				parts: [
					{ type: 'text', text: 'keep' },
					{ type: 'tool_call', toolCallId: 't1', toolName: 'x', arguments: '{}' },
				] as ChatMessage['parts'],
			}),
		);
		expect(session.text).toBe('keep');
	});

	it('refuses to open while a turn is generating', () => {
		const { session, state } = make();
		state.generating = true;
		session.begin(msg());
		expectClosed(session);
	});
});

describe('closing a session', () => {
	it('cancel fully closes', () => {
		const { session, store } = make();
		session.begin(msg({ parts: [{ type: 'image', mediaId: 'i' }] }));
		session.cancel();
		expectClosed(session);
		expect(store.items).toEqual([]);
	});

	it('a conversation switch fully closes', () => {
		// A session left open would target a message that doesn't exist in the new
		// conversation, hiding the composer with no editor to replace it.
		const { session } = make();
		session.begin(msg());
		session.closeForConversationSwitch();
		expectClosed(session);
	});

	it('save closes BEFORE sending, so the editor is gone when the bubble swaps', async () => {
		const { session, sends } = make({
			send: async () => {
				// Observed mid-send: the session must already be closed.
				throw new Error('probe');
			},
		});
		session.begin(msg({ id: 'm7' }));
		session.text = 'edited';
		await expect(session.save()).rejects.toThrow('probe');
		expectClosed(session);
		expect(sends).toEqual([]);
	});

	it('save sends the edited id and trimmed text, then closes', async () => {
		const { session, sends } = make();
		session.begin(msg({ id: 'm9' }));
		session.text = '  edited body  ';
		await session.save();

		expect(sends).toEqual([{ text: 'edited body', mediaIds: [], editedMessageId: 'm9' }]);
		expectClosed(session);
	});

	it('re-opening on another message replaces the previous session cleanly', () => {
		const { session, store } = make();
		session.begin(msg({ id: 'a', parts: [{ type: 'image', mediaId: 'old' }] }));
		session.begin(msg({ id: 'b', parts: [{ type: 'text', text: 'new' }] }));

		expect(session.messageId).toBe('b');
		expect(session.text).toBe('new');
		// The previous session's attachments must not leak into this one.
		expect(store.readyMediaIds()).toEqual([]);
	});
});

describe('save preconditions', () => {
	it('does nothing with no session open', async () => {
		const { session, sends } = make();
		await session.save();
		expect(sends).toEqual([]);
	});

	it('refuses an empty edit with no attachments', async () => {
		const { session, sends } = make();
		session.begin(msg());
		session.text = '   ';
		await session.save();
		expect(sends).toEqual([]);
		// Still open — the user should be able to keep typing or cancel.
		expect(session.active).toBe(true);
	});

	it('allows an empty text edit when attachments remain', async () => {
		const { session, sends } = make();
		session.begin(msg({ id: 'm3', parts: [{ type: 'image', mediaId: 'img' }] }));
		session.text = '';
		await session.save();
		expect(sends).toEqual([{ text: '', mediaIds: ['img'], editedMessageId: 'm3' }]);
	});

	it('refuses while an attachment is still uploading', async () => {
		const { session, sends, store } = make();
		session.begin(msg());
		session.text = 'ready';
		store.isBusy = true;
		await session.save();
		expect(sends).toEqual([]);
		expect(session.active).toBe(true);
	});

	it('refuses while a turn is generating', async () => {
		const { session, sends, state } = make();
		session.begin(msg());
		session.text = 'ready';
		state.generating = true;
		await session.save();
		expect(sends).toEqual([]);
	});
});

describe('lifecycle', () => {
	it('destroy releases the attachment store', () => {
		const { session, store } = make();
		session.destroy();
		expect(store.destroyed).toBe(1);
	});
});
