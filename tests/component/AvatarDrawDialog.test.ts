/* @vitest-environment happy-dom */

/**
 * Component test for AvatarDrawDialog — the review step before a generation is
 * spent.
 *
 * It exists because a roleplay model often answers in character first and
 * complies second, so the reply can carry prose the image model shouldn't see.
 * What's worth pinning is that the user's edit is what gets drawn, and that the
 * dialog can't be dismissed out from under a running generation.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import AvatarDrawDialog from '$lib/components/chat/AvatarDrawDialog.svelte';
import type { ComponentProps } from 'svelte';
import type { ModelEntry } from '$lib/types/api';

function imageModel(): ModelEntry {
	return {
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
}

const base: ComponentProps<typeof AvatarDrawDialog> = {
	open: true,
	prompt: 'A weathered navigator in an orange coat.',
	models: [imageModel()],
	modelId: 'mock::flux',
	enhance: true,
	status: null,
	onPromptChange: vi.fn(),
	onEnhanceChange: vi.fn(),
	onModelChange: vi.fn(),
	onDraw: vi.fn(),
	onCancel: vi.fn(),
};

const promptBox = () => screen.getByLabelText('Image prompt');
const drawButton = () => screen.getByRole('button', { name: /^(Draw|Drawing)/ });

describe('AvatarDrawDialog', () => {
	it('renders nothing when closed', () => {
		render(AvatarDrawDialog, { props: { ...base, open: false } });
		expect(screen.queryByText('Draw the avatar')).not.toBeInTheDocument();
	});

	it('shows the extracted prompt for editing and reports every change', async () => {
		const user = userEvent.setup();
		const onPromptChange = vi.fn();
		render(AvatarDrawDialog, { props: { ...base, prompt: 'Prose to trim.', onPromptChange } });

		expect(promptBox()).toHaveValue('Prose to trim.');
		await user.type(promptBox(), '!');
		expect(onPromptChange).toHaveBeenCalled();
	});

	it('refuses to draw an empty prompt', () => {
		render(AvatarDrawDialog, { props: { ...base, prompt: '   ' } });
		expect(drawButton()).toBeDisabled();
	});

	it('draws on request', async () => {
		const user = userEvent.setup();
		const onDraw = vi.fn();
		render(AvatarDrawDialog, { props: { ...base, onDraw } });
		await user.click(drawButton());
		expect(onDraw).toHaveBeenCalledOnce();
	});

	it('locks itself while a generation is running', async () => {
		// Including Cancel: dismissing mid-draw would strand a generation the user
		// can no longer watch, and the request doesn't stop just because the
		// dialog closed.
		const user = userEvent.setup();
		const onCancel = vi.fn();
		render(AvatarDrawDialog, { props: { ...base, status: 'Drawing…', onCancel } });

		expect(promptBox()).toBeDisabled();
		expect(drawButton()).toBeDisabled();
		// Twice on purpose: the button relabels AND the status line reports it, so
		// the state is legible whichever one the eye lands on.
		expect(screen.getAllByText('Drawing…')).toHaveLength(2);

		await user.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(onCancel).not.toHaveBeenCalled();
	});

	it('lets the enhancer be turned off, which is unreachable anywhere else', async () => {
		// image_prompt_enhancement is kind-scoped to image conversations, so in
		// the chat conversation an avatar is drawn from the toggle never renders.
		// This checkbox is the only way to say "send exactly what I wrote".
		const user = userEvent.setup();
		const onEnhanceChange = vi.fn();
		render(AvatarDrawDialog, { props: { ...base, enhance: true, onEnhanceChange } });

		const box = screen.getByRole('checkbox');
		expect(box).toBeChecked();
		await user.click(box);
		expect(onEnhanceChange).toHaveBeenCalledWith(false);
	});
});

/**
 * Comparing several models is offered from the same dialog, but only where the
 * result can be parked on the description — the page decides that and passes it
 * down. Two models is also the boundary the whole feature turns on: one is a
 * background draw that applies itself, two is a comparison the user resolves.
 */
describe('AvatarDrawDialog — comparing models', () => {
	it('offers the compare toggle when the page allows it', async () => {
		render(AvatarDrawDialog, { props: { ...base, canCompare: true } });
		await userEvent.click(screen.getByLabelText('Select model'));
		expect(screen.getByText('Multiple')).toBeInTheDocument();
	});

	it('withholds it, with a reason, once the conversation has moved on', async () => {
		// Not a silent absence: the control is missing for a reason the user can act
		// on (draw from the latest reply instead), so the reason is on screen.
		render(AvatarDrawDialog, {
			props: {
				...base,
				canCompare: false,
				compareBlockedReason: 'Comparing needs the description to be the latest thing.',
			},
		});
		expect(
			screen.getByText('Comparing needs the description to be the latest thing.'),
		).toBeInTheDocument();
		await userEvent.click(screen.getByLabelText('Select model'));
		expect(screen.queryByText('Multiple')).toBeNull();
	});

	it('says how many models will draw once the cart is a real comparison', () => {
		render(AvatarDrawDialog, {
			props: {
				...base,
				canCompare: true,
				compareMode: true,
				compareSelections: [
					{ modelId: 'mock::flux', count: 1 },
					{ modelId: 'mock::sdxl', count: 2 },
				],
			},
		});
		// Counts, not distinct models: asking for the same model twice is a valid
		// comparison (two samples), and it costs two branches.
		expect(screen.getByRole('button', { name: 'Draw with 3 models' })).toBeInTheDocument();
	});

	it('stays an ordinary draw while compare mode holds only one model', () => {
		// The picker's toggle is sticky — it stays on with one model in the cart.
		// Everything downstream keys off "is this actually a comparison", so the
		// button has to as well, or a single draw would announce itself as one.
		render(AvatarDrawDialog, {
			props: {
				...base,
				canCompare: true,
				compareMode: true,
				compareSelections: [{ modelId: 'mock::flux', count: 1 }],
			},
		});
		expect(screen.getByRole('button', { name: 'Draw' })).toBeInTheDocument();
	});
});
