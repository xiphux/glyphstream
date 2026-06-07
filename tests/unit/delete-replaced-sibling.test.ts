/**
 * Unit tests for the fan-out regenerate cleanup helper. deleteBranch only
 * hard-deletes rows; the media bytes must be unlinked separately or they leak
 * (the purger never sweeps `generated` media). This guards that wiring + the
 * best-effort error handling.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/db/queries/messages', () => ({ deleteBranch: vi.fn() }));
vi.mock('$lib/server/media/disk-store', () => ({ unlinkMediaFiles: vi.fn(async () => {}) }));

import { deleteBranch } from '$lib/server/db/queries/messages';
import { unlinkMediaFiles } from '$lib/server/media/disk-store';
import { deleteReplacedSibling } from '$lib/server/messages/delete-replaced-sibling';

const deleteBranchMock = vi.mocked(deleteBranch);
const unlinkMock = vi.mocked(unlinkMediaFiles);

describe('deleteReplacedSibling', () => {
	beforeEach(() => {
		deleteBranchMock.mockReset();
		unlinkMock.mockReset();
		unlinkMock.mockResolvedValue(undefined);
	});

	it('deletes the branch then unlinks its orphaned media files (no disk leak)', async () => {
		const toUnlink = [{ id: 'm1', storagePath: 'ab/cd/m1.png' }];
		deleteBranchMock.mockReturnValue({ deletedIds: ['a'], newActiveLeaf: 'u', toUnlink });
		await deleteReplacedSibling('c1', 'a', 'u1', 'image-relay.reroll');
		expect(deleteBranchMock).toHaveBeenCalledWith('c1', 'a', 'u1');
		expect(unlinkMock).toHaveBeenCalledWith(toUnlink, 'image-relay.reroll');
	});

	it('does not unlink when the delete is refused', async () => {
		deleteBranchMock.mockReturnValue({ refusedReason: 'no-siblings' });
		await deleteReplacedSibling('c1', 'a', 'u1', 'image-relay.reroll');
		expect(unlinkMock).not.toHaveBeenCalled();
	});

	it('swallows errors — the re-roll already succeeded, a leftover is harmless', async () => {
		deleteBranchMock.mockImplementation(() => {
			throw new Error('boom');
		});
		await expect(
			deleteReplacedSibling('c1', 'a', 'u1', 'video-relay.reroll'),
		).resolves.toBeUndefined();
	});
});
