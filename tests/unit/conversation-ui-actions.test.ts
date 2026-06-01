/** Tests for the pure rename-commit decision logic. */

import { describe, expect, it, vi } from 'vitest';

// conversation-ui-actions imports $app/navigation transitively (via
// fetch-error / errorMessageFromResponse → none, actually it imports
// $lib/toast directly). Mock toast to keep the module loadable.
vi.mock('$lib/toast.svelte', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const { shouldCommitRename } = await import('$lib/conversation-ui-actions.svelte');

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
