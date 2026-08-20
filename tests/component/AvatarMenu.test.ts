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
	onViewFullSize: vi.fn(),
};

/** The menu content is portaled, so open it and query the whole document. */
async function open(props: Partial<ComponentProps<typeof AvatarMenu>> = {}) {
	const user = userEvent.setup();
	render(AvatarMenu, { props: { ...base, ...props } });
	// Anchored, not exact: the trigger's label carries the status when a
	// generation is running.
	await user.click(screen.getByRole('button', { name: /^Avatar for this conversation/ }));
	return user;
}

const drawButton = () => screen.getByRole('button', { name: /^2\./ });

describe('AvatarMenu', () => {
	// Each step gets its own open() because acting DISMISSES the menu: step 1
	// hands off to the composer and step 2 opens a modal, and neither is usable
	// with the popover still covering it.
	it('runs step 1 and gets out of the way', async () => {
		const onDescribe = vi.fn();
		const user = await open({ onDescribe });

		await user.click(screen.getByRole('button', { name: '1. Ask for a description' }));
		expect(onDescribe).toHaveBeenCalledOnce();
		expect(screen.queryByRole('button', { name: /^1\./ })).not.toBeInTheDocument();
	});

	it('runs step 2 and gets out of the way', async () => {
		const onGenerate = vi.fn();
		const user = await open({ onGenerate });

		await user.click(drawButton());
		expect(onGenerate).toHaveBeenCalledOnce();
		expect(screen.queryByRole('button', { name: /^2\./ })).not.toBeInTheDocument();
	});

	it('offers the full-size view only once there is an avatar to view', async () => {
		const onViewFullSize = vi.fn();
		const user = await open({ avatarMediaId: 'media-1', onViewFullSize });

		await user.click(screen.getByRole('button', { name: 'View full size' }));
		expect(onViewFullSize).toHaveBeenCalledOnce();
	});

	it('hides the full-size view when there is no avatar', async () => {
		await open({ avatarMediaId: null });
		expect(screen.queryByRole('button', { name: 'View full size' })).not.toBeInTheDocument();
	});

	it('shows the avatar itself as the trigger', async () => {
		// The trigger IS the avatar — that's what puts the control on the thing it
		// controls instead of in a corner.
		render(AvatarMenu, { props: { ...base, avatarMediaId: 'media-1' } });
		const trigger = screen.getByRole('button', { name: 'Avatar for this conversation' });
		expect(trigger.querySelector('img')).toHaveAttribute('src', '/api/media/media-1/thumbnail');
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

	it('names the state it is in', async () => {
		await open({ avatarMediaId: 'media-1' });
		expect(screen.getByText('Conversation avatar')).toBeInTheDocument();
	});

	it('says so when there is no avatar yet', async () => {
		await open({ avatarMediaId: null });
		expect(screen.getByText('No avatar yet')).toBeInTheDocument();
	});

	it('stands both steps down while something is in flight', async () => {
		await open({ busy: true, status: 'Drawing…' });
		expect(screen.getByRole('button', { name: '1. Ask for a description' })).toBeDisabled();
		expect(drawButton()).toBeDisabled();
		expect(screen.getByText('Drawing…')).toBeInTheDocument();
	});

	it('reports a running generation on the avatar itself', async () => {
		// The dialog closes as soon as the request is accepted, so this is the
		// only thing left saying a drawing is in progress — and it stays clickable,
		// because the menu carries the same status in words.
		const user = userEvent.setup();
		render(AvatarMenu, { props: { ...base, avatarMediaId: 'media-1', status: 'Drawing…' } });

		const trigger = screen.getByRole('button', { name: /Drawing…/ });
		expect(trigger.querySelector('.animate-spin')).toBeInTheDocument();

		await user.click(trigger);
		expect(screen.getByText('Drawing…')).toBeInTheDocument();
	});

	it('shows no spinner when nothing is running', () => {
		render(AvatarMenu, { props: { ...base, avatarMediaId: 'media-1' } });
		const trigger = screen.getByRole('button', { name: 'Avatar for this conversation' });
		expect(trigger.querySelector('.animate-spin')).not.toBeInTheDocument();
	});
});
