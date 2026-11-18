/** Tests for the rename-commit decision logic and the sidebar's delete. */

import { describe, expect, it, vi } from 'vitest';

// conversation-ui-actions imports #lib/toast directly; mock it to keep the
// module loadable.
vi.mock('#lib/toast.svelte.js', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('#lib/conversation-actions.js', () => ({
	deleteConversation: vi.fn(async () => {}),
	renameConversation: vi.fn(async () => {}),
	setArchived: vi.fn(async () => {}),
}));

const { shouldCommitRename, ConversationUiActions } =
	await import('#lib/conversation-ui-actions.svelte.js');
const { deleteConversation } = await import('#lib/conversation-actions.js');
const { toast } = await import('#lib/toast.svelte.js');

describe('shouldCommitRename', () => {
	it('commits when the draft differs from the original (after trim)', () => {
		expect(shouldCommitRename('New title', 'Old title')).toEqual({
			commit: true,
			next: 'New title',
		});
	});

	it('trims surrounding whitespace before checking equality', () => {
		expect(shouldCommitRename('  New title  ', 'Old title')).toEqual({
			commit: true,
			next: 'New title',
		});
	});

	it('skips a commit when the trimmed draft equals the trimmed original', () => {
		expect(shouldCommitRename('Same', 'Same')).toEqual({ commit: false });
		expect(shouldCommitRename('  Same  ', 'Same')).toEqual({ commit: false });
		expect(shouldCommitRename('Same', '  Same  ')).toEqual({ commit: false });
	});

	it('treats an empty draft (or whitespace-only) as cancel', () => {
		expect(shouldCommitRename('', 'Old title')).toEqual({ commit: false });
		expect(shouldCommitRename('   ', 'Old title')).toEqual({ commit: false });
	});

	it('treats an empty draft as cancel even when the original was also empty', () => {
		expect(shouldCommitRename('', '')).toEqual({ commit: false });
	});
});

describe('ConversationUiActions.performDelete', () => {
	function setup(pathname: string) {
		const deps = {
			getPathname: () => pathname,
			goto: vi.fn(async () => {}),
			refreshAll: vi.fn(async () => {}),
			invalidateConversations: vi.fn(async () => {}),
		};
		vi.mocked(deleteConversation).mockClear();
		vi.mocked(toast.error).mockClear();
		return { deps, ui: new ConversationUiActions(deps) };
	}

	it('passes the media choice through and leaves the open conversation', async () => {
		const { deps, ui } = setup('/chat/c1');
		await ui.performDelete('c1', true);
		expect(deleteConversation).toHaveBeenCalledWith('c1', true);
		expect(deps.goto).toHaveBeenCalledWith('/', { refreshAll: true });
		expect(deps.invalidateConversations).not.toHaveBeenCalled();
		expect(ui.busyId).toBeNull();
	});

	it('only refreshes the sidebar when another conversation is open', async () => {
		const { deps, ui } = setup('/chat/other');
		await ui.performDelete('c1', false);
		expect(deleteConversation).toHaveBeenCalledWith('c1', false);
		expect(deps.goto).not.toHaveBeenCalled();
		expect(deps.invalidateConversations).toHaveBeenCalledOnce();
	});

	it('toasts a failure and stays put', async () => {
		const { deps, ui } = setup('/chat/c1');
		vi.mocked(deleteConversation).mockRejectedValueOnce(new Error('HTTP 500'));
		await ui.performDelete('c1', false);
		expect(toast.error).toHaveBeenCalledWith("Couldn't delete conversation: HTTP 500");
		expect(deps.goto).not.toHaveBeenCalled();
		expect(ui.busyId).toBeNull();
	});
});
