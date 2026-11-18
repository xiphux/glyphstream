/**
 * One Escape dismisses one layer. BaseDialog, MediaLightbox and the bits-ui
 * popovers inside dialogs each listen for Escape at the document or window
 * level, so without a shared rule a single key press cancelled the gallery's
 * "Delete this media?" confirmation AND closed the lightbox under it, or
 * closed a model picker AND discarded the avatar draw dialog around it.
 *
 * The confirmation cases run in both mount orders: on a first load straight
 * onto the gallery, the lightbox's window listener can be registered before
 * the layout's dialog host, so the fix can't rely on listener order.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import MediaLightbox from '#lib/components/MediaLightbox.svelte';
import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
import AvatarDrawDialog from '#lib/components/chat/AvatarDrawDialog.svelte';
import { confirmDialog } from '#lib/confirm.svelte.js';
import type { MediaListItem, ModelEntry } from '#lib/types/api.js';

vi.mock('$app/navigation', () => ({ goto: vi.fn(async () => {}) }));

afterEach(() => {
	if (confirmDialog.pending) confirmDialog.cancel();
	cleanup();
});

const media = {
	id: 'm-1',
	kind: 'image',
	contentType: 'image/png',
	byteSize: 1024,
	createdAt: Date.UTC(2026, 4, 1),
	promptExcerpt: 'harbor at dusk',
	promptFull: 'harbor at dusk',
	sourceModel: 'bridge::flux-dev',
	sourceEndpointId: 'bridge',
	conversationId: null,
	messageId: null,
	messageRole: null,
	uploadedByUserId: null,
	generatedByUserId: 'u-1',
	archived: false,
	origin: 'generated',
	favorite: false,
	width: 512,
	height: 512,
} as unknown as MediaListItem;

const model: ModelEntry = {
	id: 'mock::flux',
	endpointId: 'mock',
	upstreamId: 'flux',
	displayName: 'Flux',
	ownedBy: null,
	kind: 'image',
	kindKnown: true,
	group: 'Mock',
	groupKey: 'mock',
	supportsTools: false,
	contextWindow: null,
	promptStyle: null,
	promptHint: null,
};

describe('Escape over the media lightbox', () => {
	it('cancels a confirmation mounted after the lightbox, leaving the lightbox open', async () => {
		const user = userEvent.setup();
		const onClose = vi.fn();
		let answer: boolean | undefined;
		render(MediaLightbox, {
			props: {
				media,
				onClose,
				onDelete: () => {
					void confirmDialog
						.ask({ title: 'Delete this media?', message: 'x' })
						.then((a) => (answer = a));
				},
			},
		});
		render(ConfirmDialog);

		await user.click(screen.getByRole('button', { name: 'Delete' }));
		expect(await screen.findByRole('alertdialog')).toBeTruthy();

		await user.keyboard('{Escape}');
		await vi.waitFor(() => expect(answer).toBe(false));
		expect(screen.queryByRole('alertdialog')).toBeNull();
		expect(onClose).not.toHaveBeenCalled();
	});

	it('cancels a confirmation mounted before the lightbox, leaving the lightbox open', async () => {
		const onClose = vi.fn();
		render(ConfirmDialog);
		render(MediaLightbox, { media, onClose, onDelete: () => {} });
		const answer = confirmDialog.ask({ title: 'Delete this media?', message: 'm' });
		await tick();
		expect(screen.getByRole('alertdialog')).toBeTruthy();

		await fireEvent.keyDown(window, { key: 'Escape' });

		expect(await answer).toBe(false);
		expect(onClose).not.toHaveBeenCalled();
	});
});

describe('Escape inside the avatar draw dialog', () => {
	it('closes the model picker only, not the dialog', async () => {
		const user = userEvent.setup();
		const onCancel = vi.fn();
		render(AvatarDrawDialog, {
			props: {
				open: true,
				prompt: 'A hand-edited description.',
				models: [model],
				modelId: 'mock::flux',
				enhance: true,
				status: null,
				onPromptChange: vi.fn(),
				onEnhanceChange: vi.fn(),
				onModelChange: vi.fn(),
				onDraw: vi.fn(),
				onCancel,
			},
		});
		await user.click(screen.getByLabelText('Select model'));
		expect(screen.getByPlaceholderText('Search models…')).toBeInTheDocument();

		await user.keyboard('{Escape}');
		await vi.waitFor(() => expect(screen.queryByPlaceholderText('Search models…')).toBeNull());
		expect(onCancel).not.toHaveBeenCalled();
	});
});
