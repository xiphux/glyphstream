/* @vitest-environment happy-dom */

/**
 * Component test for MediaLightbox.
 *
 * Mocks `$app/navigation`'s `goto` so the gallery-launch buttons
 * (regenerate-with-this-prompt, use-as-starting-image) can be tested
 * without a real SvelteKit router. sessionStorage is fine in happy-dom
 * — used as the intent-handoff mechanism — so we just assert on what
 * gets stashed.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import MediaLightbox from '$lib/components/MediaLightbox.svelte';
import type { MediaConversationRef, MediaListItem } from '$lib/server/db/queries/media';

const gotoMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('$app/navigation', () => ({
	goto: gotoMock,
}));

function makeImage(overrides: Partial<MediaListItem> = {}): MediaListItem {
	return {
		id: 'm-1',
		kind: 'image',
		contentType: 'image/png',
		byteSize: 102400,
		createdAt: Date.UTC(2026, 4, 1, 12, 0, 0),
		promptExcerpt: 'a cat in a hat',
		promptFull: 'a cat in a hat sitting on a bookshelf',
		sourceModel: 'flux-dev',
		sourceEndpointId: 'bridge',
		conversationId: null,
		messageId: null,
		messageRole: null,
		uploadedByUserId: null,
		generatedByUserId: 'u-1',
		archived: false,
		...overrides,
	} as MediaListItem;
}

function makeVideo(overrides: Partial<MediaListItem> = {}): MediaListItem {
	return makeImage({ kind: 'video', contentType: 'video/mp4', ...overrides });
}

afterEach(() => {
	gotoMock.mockClear();
	window.sessionStorage.clear();
});

describe('MediaLightbox — visibility', () => {
	it('renders nothing when media is null', () => {
		render(MediaLightbox, { props: { media: null, onClose: vi.fn() } });
		expect(screen.queryByRole('dialog')).toBeNull();
	});

	it('renders the dialog when media is set', () => {
		render(MediaLightbox, { props: { media: makeImage(), onClose: vi.fn() } });
		expect(screen.getByRole('dialog')).toBeInTheDocument();
	});
});

describe('MediaLightbox — media kind', () => {
	it('renders an <img> for image kind, pointing at the content endpoint', () => {
		const { container } = render(MediaLightbox, {
			props: { media: makeImage({ id: 'abc' }), onClose: vi.fn() },
		});
		const img = container.querySelector('img')!;
		expect(img).toBeInTheDocument();
		expect(img).toHaveAttribute('src', '/api/media/abc/content');
		expect(container.querySelector('video')).toBeNull();
	});

	it('renders a <video> for video kind', () => {
		const { container } = render(MediaLightbox, {
			props: { media: makeVideo({ id: 'vid-1' }), onClose: vi.fn() },
		});
		const video = container.querySelector('video');
		expect(video).toBeInTheDocument();
		expect(video).toHaveAttribute('src', '/api/media/vid-1/content');
		expect(container.querySelector('img')).toBeNull();
	});
});

describe('MediaLightbox — header metadata', () => {
	it('shows the source model name', () => {
		render(MediaLightbox, {
			props: { media: makeImage({ sourceModel: 'flux-pro' }), onClose: vi.fn() },
		});
		expect(screen.getByText('flux-pro')).toBeInTheDocument();
	});

	it('falls back to "Unknown model" when sourceModel is null', () => {
		render(MediaLightbox, {
			props: { media: makeImage({ sourceModel: null }), onClose: vi.fn() },
		});
		expect(screen.getByText('Unknown model')).toBeInTheDocument();
	});
});

describe('MediaLightbox — close interactions', () => {
	it('fires onClose when the Close button is clicked', async () => {
		const user = userEvent.setup();
		const onClose = vi.fn();
		render(MediaLightbox, { props: { media: makeImage(), onClose } });
		await user.click(screen.getByRole('button', { name: 'Close' }));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('fires onClose on Escape', async () => {
		const user = userEvent.setup();
		const onClose = vi.fn();
		render(MediaLightbox, { props: { media: makeImage(), onClose } });
		await user.keyboard('{Escape}');
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('does NOT respond to Escape when no media is open', async () => {
		const user = userEvent.setup();
		const onClose = vi.fn();
		render(MediaLightbox, { props: { media: null, onClose } });
		await user.keyboard('{Escape}');
		expect(onClose).not.toHaveBeenCalled();
	});

	it('fires onClose on backdrop click', async () => {
		const onClose = vi.fn();
		render(MediaLightbox, { props: { media: makeImage(), onClose } });
		await fireEvent.click(screen.getByRole('dialog'));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('does NOT fire onClose on inner-content click', async () => {
		const user = userEvent.setup();
		const onClose = vi.fn();
		render(MediaLightbox, {
			props: { media: makeImage({ sourceModel: 'flux-pro' }), onClose },
		});
		// Click the source-model text — bubble-up should be filtered out
		// by the e.target === e.currentTarget guard.
		await user.click(screen.getByText('flux-pro'));
		expect(onClose).not.toHaveBeenCalled();
	});
});

describe('MediaLightbox — save button', () => {
	// happy-dom exposes no Web Share API, so the component falls back to
	// the blob-URL download path and labels the control "Download".
	it('renders a download button (no share API in this env)', () => {
		render(MediaLightbox, {
			props: { media: makeImage({ id: 'xyz' }), onClose: vi.fn() },
		});
		expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument();
		// No longer a navigating anchor — the old trap on iOS is gone.
		expect(screen.queryByRole('link', { name: 'Download' })).toBeNull();
	});

	it('fetches the content endpoint and triggers a blob download when clicked', async () => {
		const user = userEvent.setup();
		const fetchMock = vi.fn(async () => new Response(new Blob(['data']), { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		const createObjectURL = vi.fn(() => 'blob:fake');
		const revokeObjectURL = vi.fn();
		vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
		const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

		render(MediaLightbox, {
			props: { media: makeImage({ id: 'xyz' }), onClose: vi.fn() },
		});
		await user.click(screen.getByRole('button', { name: 'Download' }));

		expect(fetchMock).toHaveBeenCalledWith('/api/media/xyz/content');
		expect(createObjectURL).toHaveBeenCalled();
		expect(clickSpy).toHaveBeenCalled();
		expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake');

		clickSpy.mockRestore();
		vi.unstubAllGlobals();
	});

	it('uses the native share sheet on a touch-primary device with file sharing', async () => {
		const user = userEvent.setup();
		const fetchMock = vi.fn(async () => new Response(new Blob(['data']), { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		const share = vi.fn(async (_data: ShareData) => {});
		const canShare = vi.fn(() => true);
		vi.stubGlobal('navigator', { ...navigator, share, canShare });
		// Simulate a touch-primary device (pointer: coarse) so the share
		// sheet path is taken — desktop (pointer: fine) downloads directly.
		vi.stubGlobal(
			'matchMedia',
			vi.fn((q: string) => ({ matches: q.includes('coarse'), media: q })),
		);

		render(MediaLightbox, {
			props: { media: makeImage({ id: 'xyz', contentType: 'image/webp' }), onClose: vi.fn() },
		});
		// Control surfaces as "Share or save" once the share API is present.
		const btn = screen.getByRole('button', { name: 'Share or save' });
		await user.click(btn);

		expect(fetchMock).toHaveBeenCalledWith('/api/media/xyz/content');
		expect(share).toHaveBeenCalledOnce();
		const shared = share.mock.calls[0][0];
		expect(shared.files?.[0]).toBeInstanceOf(File);
		// glyphstream-<YYYYMMDD-HHMMSS>-<8-char id>.<ext>; the timestamp is
		// rendered in the runner's local time so match it loosely.
		expect(shared.files?.[0].name).toMatch(/^glyphstream-\d{8}-\d{6}-xyz\.webp$/);

		vi.unstubAllGlobals();
	});

	it('downloads (not shares) on a desktop that supports the share API', async () => {
		const user = userEvent.setup();
		const fetchMock = vi.fn(async () => new Response(new Blob(['data']), { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		const share = vi.fn(async () => {});
		const canShare = vi.fn(() => true);
		vi.stubGlobal('navigator', { ...navigator, share, canShare });
		// macOS Safari case: share API present, but a fine pointer (mouse /
		// trackpad) means we should download directly, not pop the sheet.
		// `(pointer: coarse)` does not match on this device.
		vi.stubGlobal(
			'matchMedia',
			vi.fn((q: string) => ({ matches: false, media: q })),
		);
		const createObjectURL = vi.fn(() => 'blob:fake');
		const revokeObjectURL = vi.fn();
		vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
		const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

		render(MediaLightbox, {
			props: { media: makeImage({ id: 'xyz' }), onClose: vi.fn() },
		});
		// Fine pointer → labeled "Download", and clicking takes the blob path.
		await user.click(screen.getByRole('button', { name: 'Download' }));

		expect(share).not.toHaveBeenCalled();
		expect(createObjectURL).toHaveBeenCalled();
		expect(clickSpy).toHaveBeenCalled();

		clickSpy.mockRestore();
		vi.unstubAllGlobals();
	});
});

describe('MediaLightbox — delete button', () => {
	it('is hidden when onDelete is not provided', () => {
		render(MediaLightbox, { props: { media: makeImage(), onClose: vi.fn() } });
		expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
	});

	it('is shown when onDelete is provided', () => {
		render(MediaLightbox, {
			props: { media: makeImage(), onClose: vi.fn(), onDelete: vi.fn() },
		});
		expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
	});

	it('calls onDelete with the media id when clicked', async () => {
		const user = userEvent.setup();
		const onDelete = vi.fn();
		render(MediaLightbox, {
			props: { media: makeImage({ id: 'target' }), onClose: vi.fn(), onDelete },
		});
		await user.click(screen.getByRole('button', { name: 'Delete' }));
		expect(onDelete).toHaveBeenCalledWith('target');
	});

	it('is disabled when deletingId matches media.id', () => {
		render(MediaLightbox, {
			props: {
				media: makeImage({ id: 'in-flight' }),
				onClose: vi.fn(),
				onDelete: vi.fn(),
				deletingId: 'in-flight',
			},
		});
		const btn = screen.getByRole('button', { name: 'Delete' });
		expect(btn).toBeDisabled();
		expect(btn).toHaveAttribute('title', 'Deleting…');
	});

	it('is enabled when deletingId is a different id', () => {
		render(MediaLightbox, {
			props: {
				media: makeImage({ id: 'this' }),
				onClose: vi.fn(),
				onDelete: vi.fn(),
				deletingId: 'other',
			},
		});
		expect(screen.getByRole('button', { name: 'Delete' })).not.toBeDisabled();
	});
});

describe('MediaLightbox — prompt + launch actions', () => {
	it('renders the prompt excerpt when present', () => {
		render(MediaLightbox, {
			props: {
				media: makeImage({ promptExcerpt: 'a vivid sunset' }),
				onClose: vi.fn(),
			},
		});
		expect(screen.getByText('a vivid sunset')).toBeInTheDocument();
	});

	it('hides the prompt strip when both promptExcerpt and promptFull are null', () => {
		render(MediaLightbox, {
			props: {
				media: makeImage({ promptExcerpt: null, promptFull: null }),
				onClose: vi.fn(),
			},
		});
		expect(screen.queryByRole('button', { name: /Regenerate/ })).toBeNull();
	});

	it('shows the Regenerate button when a prompt is present', () => {
		render(MediaLightbox, {
			props: {
				media: makeImage({ promptFull: 'render a cat in a hat' }),
				onClose: vi.fn(),
			},
		});
		expect(screen.getByRole('button', { name: 'Regenerate with this prompt' })).toBeInTheDocument();
	});

	it('uses the in-conversation label variant when inConversation=true', () => {
		render(MediaLightbox, {
			props: {
				media: makeImage(),
				onClose: vi.fn(),
				inConversation: true,
			},
		});
		expect(screen.getByRole('button', { name: 'Regenerate in a new chat' })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Regenerate with this prompt' })).toBeNull();
	});

	it('shows "Use as starting image" only for image kind', () => {
		render(MediaLightbox, { props: { media: makeImage(), onClose: vi.fn() } });
		expect(screen.getByRole('button', { name: 'Use as starting image' })).toBeInTheDocument();
	});

	it('hides "Use as starting image" for video kind', () => {
		render(MediaLightbox, { props: { media: makeVideo(), onClose: vi.fn() } });
		expect(screen.queryByRole('button', { name: 'Use as starting image' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Edit in a new chat' })).toBeNull();
	});

	it('Regenerate stashes the intent and navigates to /', async () => {
		const user = userEvent.setup();
		const onClose = vi.fn();
		const media = makeImage({
			promptFull: 'big sky',
			sourceEndpointId: 'bridge',
			sourceModel: 'flux-dev',
		});
		render(MediaLightbox, { props: { media, onClose } });
		await user.click(screen.getByRole('button', { name: 'Regenerate with this prompt' }));
		const stashed = JSON.parse(window.sessionStorage.getItem('glyphstream:galleryLaunch')!);
		expect(stashed).toEqual({
			kind: 'regenerate',
			prompt: 'big sky',
			sourceModelId: 'bridge::flux-dev',
		});
		expect(onClose).toHaveBeenCalled();
		expect(gotoMock).toHaveBeenCalledWith('/');
	});

	it('Regenerate falls back to promptExcerpt when promptFull is null', async () => {
		const user = userEvent.setup();
		const media = makeImage({
			promptFull: null,
			promptExcerpt: 'excerpt only',
			sourceEndpointId: 'bridge',
			sourceModel: 'flux-dev',
		});
		render(MediaLightbox, { props: { media, onClose: vi.fn() } });
		await user.click(screen.getByRole('button', { name: 'Regenerate with this prompt' }));
		const stashed = JSON.parse(window.sessionStorage.getItem('glyphstream:galleryLaunch')!);
		expect(stashed.prompt).toBe('excerpt only');
	});

	it('Use as starting image stashes the right intent', async () => {
		const user = userEvent.setup();
		const onClose = vi.fn();
		const media = makeImage({
			id: 'm-7',
			sourceEndpointId: 'bridge',
			sourceModel: 'flux-dev',
		});
		render(MediaLightbox, { props: { media, onClose } });
		await user.click(screen.getByRole('button', { name: 'Use as starting image' }));
		const stashed = JSON.parse(window.sessionStorage.getItem('glyphstream:galleryLaunch')!);
		expect(stashed).toEqual({
			kind: 'starting-image',
			mediaId: 'm-7',
			sourceModelId: 'bridge::flux-dev',
		});
		expect(onClose).toHaveBeenCalled();
		expect(gotoMock).toHaveBeenCalledWith('/');
	});

	it('stashes null sourceModelId when the media has no source endpoint', async () => {
		const user = userEvent.setup();
		const media = makeImage({
			sourceEndpointId: null,
			sourceModel: 'flux-dev',
		});
		render(MediaLightbox, { props: { media, onClose: vi.fn() } });
		await user.click(screen.getByRole('button', { name: 'Regenerate with this prompt' }));
		const stashed = JSON.parse(window.sessionStorage.getItem('glyphstream:galleryLaunch')!);
		expect(stashed.sourceModelId).toBeNull();
	});
});

describe('MediaLightbox — conversationsUsingThis', () => {
	it('omits the section entirely when undefined', () => {
		render(MediaLightbox, { props: { media: makeImage(), onClose: vi.fn() } });
		expect(screen.queryByText(/Loading conversations/)).toBeNull();
		expect(screen.queryByText(/Not used in any conversation/)).toBeNull();
		expect(screen.queryByText(/Used in/)).toBeNull();
	});

	it('shows "Loading conversations…" while null', () => {
		render(MediaLightbox, {
			props: {
				media: makeImage(),
				onClose: vi.fn(),
				conversationsUsingThis: null,
			},
		});
		expect(screen.getByText('Loading conversations…')).toBeInTheDocument();
	});

	it('shows the "not used in any conversation" message on empty array', () => {
		render(MediaLightbox, {
			props: {
				media: makeImage(),
				onClose: vi.fn(),
				conversationsUsingThis: [],
			},
		});
		expect(screen.getByText('Not used in any conversation.')).toBeInTheDocument();
	});

	it('renders the conversation list when non-empty', () => {
		const refs: MediaConversationRef[] = [
			{ id: 'c-1', title: 'Chat about pastries', updatedAt: 0, archivedAt: null },
			{ id: 'c-2', title: 'Old debugging session', updatedAt: 0, archivedAt: 12345 },
		];
		render(MediaLightbox, {
			props: {
				media: makeImage(),
				onClose: vi.fn(),
				conversationsUsingThis: refs,
			},
		});
		expect(screen.getByText('Chat about pastries')).toBeInTheDocument();
		expect(screen.getByText('Old debugging session')).toBeInTheDocument();
		// Archived flag renders alongside the title.
		expect(screen.getByText('archived')).toBeInTheDocument();
		expect(screen.getByText(/Used in 2 conversations:/)).toBeInTheDocument();
	});

	it('renders a single conversation as an inline link, not a "Used in 1" list', () => {
		const refs: MediaConversationRef[] = [
			{ id: 'c-9', title: 'Just this one', updatedAt: 0, archivedAt: null },
		];
		render(MediaLightbox, {
			props: { media: makeImage(), onClose: vi.fn(), conversationsUsingThis: refs },
		});
		// Inline "In conversation: <link>" phrasing for the common case.
		expect(screen.getByText('In conversation:')).toBeInTheDocument();
		const link = screen.getByRole('link', { name: 'Just this one' });
		expect(link).toHaveAttribute('href', '/chat/c-9');
		// The plural-list scaffolding must NOT appear for a single conversation.
		expect(screen.queryByText(/Used in/)).toBeNull();
	});

	it('shows the archived flag in the single-conversation case', () => {
		const refs: MediaConversationRef[] = [
			{ id: 'c-9', title: 'Archived chat', updatedAt: 0, archivedAt: 12345 },
		];
		render(MediaLightbox, {
			props: { media: makeImage(), onClose: vi.fn(), conversationsUsingThis: refs },
		});
		expect(screen.getByText('In conversation:')).toBeInTheDocument();
		expect(screen.getByText('archived')).toBeInTheDocument();
	});

	it('shows the conversationsError message when set', () => {
		// The error branch only fires when conversationsUsingThis is a
		// non-null array (the null state is the "loading" branch). Passing
		// [] alongside the error lets the {:else if conversationsError}
		// branch win over the empty-list "not used in any conversation" branch.
		render(MediaLightbox, {
			props: {
				media: makeImage(),
				onClose: vi.fn(),
				conversationsUsingThis: [],
				conversationsError: 'Network blew up',
			},
		});
		expect(screen.getByText('Network blew up')).toBeInTheDocument();
	});

	it('handles "Untitled" fallback for null conversation titles', () => {
		const refs: MediaConversationRef[] = [
			{ id: 'c-3', title: null, updatedAt: 0, archivedAt: null },
		];
		render(MediaLightbox, {
			props: {
				media: makeImage(),
				onClose: vi.fn(),
				conversationsUsingThis: refs,
			},
		});
		expect(screen.getByText('Untitled')).toBeInTheDocument();
	});
});

describe('MediaLightbox — carousel navigation', () => {
	const siblings = [
		{ id: 'm-1', kind: 'image' as const },
		{ id: 'm-2', kind: 'image' as const },
		{ id: 'm-3', kind: 'video' as const },
	];

	it('shows no nav affordances without siblings', () => {
		render(MediaLightbox, { props: { media: makeImage(), onClose: vi.fn() } });
		expect(screen.queryByRole('button', { name: 'Previous' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
	});

	it('shows no nav affordances for a single-entry sibling set', () => {
		render(MediaLightbox, {
			props: {
				media: makeImage({ id: 'm-1' }),
				onClose: vi.fn(),
				siblings: [{ id: 'm-1', kind: 'image' as const }],
				onNavigate: vi.fn(),
			},
		});
		expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
	});

	it('renders arrows and a position counter when there are 2+ siblings', () => {
		render(MediaLightbox, {
			props: {
				media: makeImage({ id: 'm-2' }),
				onClose: vi.fn(),
				siblings,
				onNavigate: vi.fn(),
			},
		});
		expect(screen.getByRole('button', { name: 'Previous' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Next' })).toBeInTheDocument();
		// m-2 is index 1 of 3.
		expect(screen.getByText('2 / 3')).toBeInTheDocument();
	});

	it('renders a slide per sibling, picking the element by kind', () => {
		const { container } = render(MediaLightbox, {
			props: {
				media: makeImage({ id: 'm-1' }),
				onClose: vi.fn(),
				siblings,
				onNavigate: vi.fn(),
			},
		});
		// Two image slides + one video slide.
		expect(container.querySelectorAll('img')).toHaveLength(2);
		const video = container.querySelector('video');
		expect(video).toHaveAttribute('src', '/api/media/m-3/content');
	});

	it('Next/Previous call onNavigate with the adjacent id', async () => {
		const user = userEvent.setup();
		const onNavigate = vi.fn();
		render(MediaLightbox, {
			props: { media: makeImage({ id: 'm-2' }), onClose: vi.fn(), siblings, onNavigate },
		});
		await user.click(screen.getByRole('button', { name: 'Next' }));
		expect(onNavigate).toHaveBeenCalledWith('m-3');
		await user.click(screen.getByRole('button', { name: 'Previous' }));
		expect(onNavigate).toHaveBeenCalledWith('m-1');
	});

	it('disables Previous on the first item and Next on the last', () => {
		const { rerender } = render(MediaLightbox, {
			props: { media: makeImage({ id: 'm-1' }), onClose: vi.fn(), siblings, onNavigate: vi.fn() },
		});
		expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
		expect(screen.getByRole('button', { name: 'Next' })).not.toBeDisabled();

		rerender({ media: makeVideo({ id: 'm-3' }), onClose: vi.fn(), siblings, onNavigate: vi.fn() });
		expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
		expect(screen.getByRole('button', { name: 'Previous' })).not.toBeDisabled();
	});

	it('ArrowRight / ArrowLeft keys navigate', async () => {
		const user = userEvent.setup();
		const onNavigate = vi.fn();
		render(MediaLightbox, {
			props: { media: makeImage({ id: 'm-2' }), onClose: vi.fn(), siblings, onNavigate },
		});
		await user.keyboard('{ArrowRight}');
		expect(onNavigate).toHaveBeenCalledWith('m-3');
		await user.keyboard('{ArrowLeft}');
		expect(onNavigate).toHaveBeenCalledWith('m-1');
	});

	it('does not navigate past the ends', async () => {
		const user = userEvent.setup();
		const onNavigate = vi.fn();
		render(MediaLightbox, {
			props: { media: makeImage({ id: 'm-1' }), onClose: vi.fn(), siblings, onNavigate },
		});
		await user.keyboard('{ArrowLeft}');
		expect(onNavigate).not.toHaveBeenCalled();
	});

	it('falls back to the single-item view when the open item is not in the set', () => {
		render(MediaLightbox, {
			props: {
				media: makeImage({ id: 'not-in-set' }),
				onClose: vi.fn(),
				siblings,
				onNavigate: vi.fn(),
			},
		});
		// currentIndex === -1 → no carousel chrome.
		expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
	});
});
