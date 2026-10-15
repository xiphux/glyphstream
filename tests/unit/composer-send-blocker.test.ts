/**
 * The one send rule both composers use: the chat page's (`ChatComposer`) and
 * the new-chat page's. They used to compute it separately and had drifted.
 */
import { describe, expect, it } from 'vitest';
import { composerSendBlocker, sendBlockerTitle, type ComposerSendState } from '#lib/composer.js';

const ready: ComposerSendState = {
	hasModel: true,
	hasContent: true,
	busy: false,
	offline: false,
	needsImage: false,
	attachmentErrors: false,
	attachmentsBlock: false,
};

describe('composerSendBlocker', () => {
	it('allows a send when nothing blocks it', () => {
		expect(composerSendBlocker(ready)).toBeNull();
	});

	it.each([
		['no-model', { hasModel: false }],
		['offline', { offline: true }],
		['needs-image', { needsImage: true }],
		['attachment-error', { attachmentErrors: true, attachmentsBlock: true }],
		['uploading', { attachmentsBlock: true }],
		['empty', { hasContent: false }],
		['busy', { busy: true }],
	] as const)('reports %s', (blocker, over) => {
		expect(composerSendBlocker({ ...ready, ...over })).toBe(blocker);
	});

	it('names the reason worth telling the user first', () => {
		// Offline with no model and an empty box: picking a model comes first.
		expect(
			composerSendBlocker({ ...ready, hasModel: false, offline: true, hasContent: false }),
		).toBe('no-model');
		// A failed upload outranks an empty box, so its tooltip shows.
		expect(
			composerSendBlocker({
				...ready,
				hasContent: false,
				attachmentErrors: true,
				attachmentsBlock: true,
			}),
		).toBe('attachment-error');
	});
});

describe('sendBlockerTitle', () => {
	it('explains the blockers a user can act on, and stays quiet otherwise', () => {
		expect(sendBlockerTitle('no-model')).toBe('Pick a model to send');
		expect(sendBlockerTitle('offline')).toMatch(/offline/);
		expect(sendBlockerTitle('needs-image')).toMatch(/needs an image/);
		expect(sendBlockerTitle('attachment-error')).toMatch(/failed to upload/);
		for (const b of ['uploading', 'empty', 'busy', null] as const) {
			expect(sendBlockerTitle(b)).toBeNull();
		}
	});
});
