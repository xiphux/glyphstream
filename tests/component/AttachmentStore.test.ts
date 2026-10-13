/**
 * AttachmentStore adds a picked file's placeholder BEFORE it resizes the
 * image, not after.
 *
 * Added after the await, the file wasn't in the strip while it resized: a send
 * (or a conversation switch) in that window cleared the strip and sent without
 * it, and the file then reappeared afterwards — uploaded — in the next
 * message's attachments. And `isBusy` read false the whole time, so nothing
 * held the send back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttachmentStore } from '#lib/attachments.svelte.js';

const png = () => new File([new Uint8Array([137, 80, 78, 71])], 'tiny.png', { type: 'image/png' });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
	fetchMock = vi.fn(async () =>
		Response.json({ id: 'm1', kind: 'image', originalFilename: 'tiny.png' }),
	);
	vi.stubGlobal('fetch', fetchMock);
	vi.stubGlobal(
		'URL',
		Object.assign(URL, {
			createObjectURL: vi.fn(() => 'blob:x'),
			revokeObjectURL: vi.fn(),
		}),
	);
});
afterEach(() => vi.unstubAllGlobals());

describe('AttachmentStore', () => {
	it('counts a picked image as busy while it is still being prepared', () => {
		const store = new AttachmentStore();
		void store.addFiles([png()]);
		expect(store.isBusy).toBe(true);
	});

	it('does not bring back, or upload, a file cleared while it was being prepared', async () => {
		const store = new AttachmentStore();
		const adding = store.addFiles([png()]);
		store.clear(); // a send, or a conversation switch, in that window
		await adding;
		expect(store.items).toEqual([]);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('still uploads normally', async () => {
		const store = new AttachmentStore();
		await store.addFiles([png()]);
		expect(store.readyMediaIds()).toEqual(['m1']);
		expect(store.blocksSend).toBe(false);
	});

	it('holds the send while an upload has failed, until the failed one is removed', async () => {
		fetchMock.mockResolvedValueOnce(Response.json({ message: 'too large' }, { status: 413 }));
		const store = new AttachmentStore();
		await store.addFiles([png()]);
		expect(store.hasErrors).toBe(true);
		expect(store.blocksSend).toBe(true);
		store.remove(store.items[0].clientId);
		expect(store.blocksSend).toBe(false);
	});
});
