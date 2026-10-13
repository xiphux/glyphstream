/**
 * Persisting generated media builds its thumbnail straight away, so the first
 * gallery view (or a video's poster) finds it cached instead of queueing a
 * generation per tile.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getOrCreateThumbnail: vi.fn() }));
vi.mock('#lib/server/media/thumbnail.js', () => ({
	getOrCreateThumbnail: mocks.getOrCreateThumbnail,
}));
vi.mock('#lib/server/media/disk-store.js', () => ({
	getMediaStore: () => ({
		put: vi.fn(async () => ({ storagePath: 'ab/cd.png', contentType: 'image/png', byteSize: 3 })),
	}),
}));
vi.mock('#lib/server/db/queries/media.js', () => ({
	insertMedia: vi.fn(() => ({ id: 'media-1' })),
}));

import { persistGeneratedImage } from '#lib/server/media/persister.js';
import type { LoadedEndpoint } from '#lib/server/endpoints/config.js';

const endpoint = { id: 'e', baseUrl: 'http://x/v1' } as unknown as LoadedEndpoint;
const persist = () =>
	persistGeneratedImage({
		userId: 'u',
		endpoint,
		sourceModel: 'm',
		prompt: 'p',
		urlOrB64: { b64_json: Buffer.from('png').toString('base64') },
	});

beforeEach(() => {
	mocks.getOrCreateThumbnail.mockReset().mockResolvedValue({ storagePath: 't' });
});
afterEach(() => vi.restoreAllMocks());

describe('persistGeneratedImage — thumbnail prewarm', () => {
	it('starts the thumbnail for the stored original', async () => {
		expect(await persist()).toBe('media-1');
		expect(mocks.getOrCreateThumbnail).toHaveBeenCalledWith('ab/cd.png', 'image');
	});

	it('still returns the media id when the prewarm fails', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		mocks.getOrCreateThumbnail.mockRejectedValue(new Error('sharp exploded'));
		expect(await persist()).toBe('media-1');
		await vi.waitFor(() => expect(warn).toHaveBeenCalled());
	});
});
