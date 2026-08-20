/* @vitest-environment happy-dom */

/**
 * Component test for AvatarMenu.
 *
 * The menu is where the two-step flow explains itself, so what's worth pinning
 * is that it tells the truth about which step is available and why: no image
 * model, no reply to draw from, or a description that's already been drawn (a
 * re-roll rather than a first attempt).
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import AvatarMenu from '$lib/components/chat/AvatarMenu.svelte';
import type { ComponentProps } from 'svelte';

const base: ComponentProps<typeof AvatarMenu> = {
	hasImageModel: true,
	avatarMediaId: null,
	hasSource: true,
	alreadyDrawn: false,
	status: null,
	busy: false,
	onDescribe: vi.fn(),
	onGenerate: vi.fn(),
};

/** The menu content is portaled, so open it and query the whole document. */
async function open(props: Partial<ComponentProps<typeof AvatarMenu>> = {}) {
	const user = userEvent.setup();
	render(AvatarMenu, { props: { ...base, ...props } });
	await user.click(screen.getByRole('button', { name: 'Avatar for this conversation' }));
	return user;
}

const drawButton = () => screen.getByRole('button', { name: /^2\./ });

describe('AvatarMenu', () => {
	it('runs each step through its own callback', async () => {
		const onDescribe = vi.fn();
		const onGenerate = vi.fn();
		const user = await open({ onDescribe, onGenerate });

		await user.click(screen.getByRole('button', { name: '1. Ask for a description' }));
		expect(onDescribe).toHaveBeenCalledOnce();

		await user.click(drawButton());
		expect(onGenerate).toHaveBeenCalledOnce();
	});

	it('blocks and explains step 2 before there is anything to draw', async () => {
		await open({ hasSource: false });
		expect(drawButton()).toBeDisabled();
		expect(screen.getByText('Send the description request first.')).toBeInTheDocument();
	});

	it('blocks and explains step 2 when no image model is configured', async () => {
		await open({ hasImageModel: false });
		expect(drawButton()).toBeDisabled();
		expect(screen.getByText('No image model is configured.')).toBeInTheDocument();
	});

	it('reads as a re-roll once the description has been drawn', async () => {
		// The call is identical either way — only the wording changes, because a
		// second generation lands as a sibling rather than replacing anything.
		await open({ alreadyDrawn: true, avatarMediaId: 'media-1' });
		expect(screen.getByRole('button', { name: '2. Draw it again' })).toBeEnabled();
		expect(screen.getByText(/Same description again/)).toBeInTheDocument();
	});

	it('reports the conversation avatar it already has', async () => {
		await open({ avatarMediaId: 'media-1' });
		expect(screen.getByText('Conversation avatar')).toBeInTheDocument();
		expect(document.querySelector('img[src="/api/media/media-1/thumbnail"]')).toBeInTheDocument();
	});

	it('stands both steps down while something is in flight', async () => {
		await open({ busy: true, status: 'Drawing…' });
		expect(screen.getByRole('button', { name: '1. Ask for a description' })).toBeDisabled();
		expect(drawButton()).toBeDisabled();
		expect(screen.getByText('Drawing…')).toBeInTheDocument();
	});
});
