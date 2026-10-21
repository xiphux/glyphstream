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
import MediaLightbox from '#lib/components/MediaLightbox.svelte';
import { tick } from 'svelte';
import type { MediaConversationRef, MediaListItem } from '#lib/types/api.js';

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
		// `sourceModel` holds the WHOLE internal id, not the upstream half —
		// that's what the relay's `storedModelId` writes. Fixtures that said
		// `flux-dev` here let a doubled-prefix bug ship (see mediaSourceModelId).
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
		...overrides,
	} as MediaListItem;
}

function makeVideo(overrides: Partial<MediaListItem> = {}): MediaListItem {
	return makeImage({ kind: 'video', contentType: 'video/mp4', ...overrides });
}

/**
 * Stub `matchMedia` so `(pointer: coarse)` reports `coarse`.
 *
 * The component reads the pointer type through Svelte's `MediaQuery`, which
 * SUBSCRIBES to the MediaQueryList (`addEventListener('change', …)`) rather than
 * just reading `.matches` once. A `{ matches, media }` literal is therefore no
 * longer a sufficient double — it throws "dom.addEventListener is not a
 * function" at render, and because that kills the render before the test's
 * trailing `unstubAllGlobals()`, the thin stub leaks into every later test in
 * the file. Hence the no-op listener pair.
 */
function stubPointerQuery(coarse: boolean) {
	vi.stubGlobal(
		'matchMedia',
		vi.fn((q: string) => ({
			matches: coarse && q.includes('coarse'),
			media: q,
			onchange: null,
			addEventListener: () => {},
			removeEventListener: () => {},
			addListener: () => {},
			removeListener: () => {},
			dispatchEvent: () => false,
		})),
	);
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
	it('shows the source model name with its endpoint and owner prefixes stripped', () => {
		render(MediaLightbox, {
			props: { media: makeImage({ sourceModel: 'bridge::comfyui/flux-pro' }), onClose: vi.fn() },
		});
		expect(screen.getByText('flux-pro')).toBeInTheDocument();
		// The whole id stays reachable to a pointer. Touch gets no tooltip, which
		// is why the endpoint also appears in the metadata line (asserted below).
		expect(screen.getByText('flux-pro')).toHaveAttribute('title', 'bridge::comfyui/flux-pro');
	});

	it('falls back to "Unknown model" when sourceModel is null', () => {
		render(MediaLightbox, {
			props: { media: makeImage({ sourceModel: null }), onClose: vi.fn() },
		});
		expect(screen.getByText('Unknown model')).toBeInTheDocument();
	});

	// The endpoint is what the header's friendly label drops, and `title` is
	// pointer-only, so the metadata line is where it has to be readable on
	// touch. Asserted as text rather than via the tooltip for that reason.
	it('names the source endpoint in the metadata line', () => {
		render(MediaLightbox, {
			props: {
				media: makeImage({ sourceEndpointId: 'bridge-dev', sourceModel: 'bridge-dev::anima' }),
				onClose: vi.fn(),
			},
		});
		// Anchored PAST the separator: `/^bridge-dev ·/` matched the broken
		// `bridge-dev ·5/1/2026` rendering too, which is how a swallowed space
		// shipped. The date is locale-dependent, hence `.+` in the middle.
		expect(screen.getByText(/^bridge-dev · .+ · 100 KB · image\/png$/)).toBeInTheDocument();
	});

	it('reports the aspect ratio between the date and the size', () => {
		render(MediaLightbox, {
			props: {
				media: makeImage({
					sourceEndpointId: 'bridge-dev',
					sourceModel: 'bridge-dev::anima',
					aspectRatio: '16:9',
				}),
				onClose: vi.fn(),
			},
		});
		expect(screen.getByText(/^bridge-dev · .+ · 16:9 · 100 KB · image\/png$/)).toBeInTheDocument();
	});

	it('omits the aspect ratio when none was recorded', () => {
		// The common case by a wide margin: uploads, pre-feature rows, and every
		// upstream that doesn't report a ratio. A placeholder segment here would
		// put a stray separator on almost every row in the gallery.
		render(MediaLightbox, {
			props: {
				media: makeImage({
					sourceEndpointId: 'bridge-dev',
					sourceModel: 'bridge-dev::anima',
					aspectRatio: null,
				}),
				onClose: vi.fn(),
			},
		});
		expect(screen.getByText(/^bridge-dev · .+ · 100 KB · image\/png$/)).toBeInTheDocument();
	});

	it('omits the endpoint from the metadata line when none is recorded', () => {
		render(MediaLightbox, {
			props: {
				// An upload: no endpoint, no model, nothing to regenerate on.
				media: makeImage({ sourceEndpointId: null, sourceModel: null }),
				onClose: vi.fn(),
			},
		});
		expect(screen.queryByText(/^bridge/)).toBeNull();
		// No endpoint => no leading segment and no stray separator.
		expect(screen.getByText(/^.+ · 100 KB · image\/png$/)).toBeInTheDocument();
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
			props: { media: makeImage({ sourceModel: 'bridge::comfyui/flux-pro' }), onClose },
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
		stubPointerQuery(true);

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
		stubPointerQuery(false);
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

describe('MediaLightbox — favorite star', () => {
	it('is hidden when onToggleFavorite is not provided', () => {
		// How the chat surface withholds it for an uploaded asset: the gallery never
		// lists uploads, so a star there could never be found again.
		render(MediaLightbox, { props: { media: makeImage(), onClose: vi.fn() } });
		expect(screen.queryByRole('button', { name: 'Add to favorites' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Remove from favorites' })).toBeNull();
	});

	it('offers to add when the media is not starred', () => {
		render(MediaLightbox, {
			props: { media: makeImage(), onClose: vi.fn(), onToggleFavorite: vi.fn() },
		});
		const btn = screen.getByRole('button', { name: 'Add to favorites' });
		expect(btn).toBeInTheDocument();
		expect(btn).toHaveAttribute('aria-pressed', 'false');
	});

	it('offers to remove when the media is starred', () => {
		render(MediaLightbox, {
			props: {
				media: makeImage({ favorite: true }),
				onClose: vi.fn(),
				onToggleFavorite: vi.fn(),
			},
		});
		const btn = screen.getByRole('button', { name: 'Remove from favorites' });
		expect(btn).toHaveAttribute('aria-pressed', 'true');
	});

	it('asks for the OPPOSITE of the current state, with the media id', async () => {
		const user = userEvent.setup();
		const onToggleFavorite = vi.fn();
		render(MediaLightbox, {
			props: {
				media: makeImage({ id: 'target', favorite: true }),
				onClose: vi.fn(),
				onToggleFavorite,
			},
		});
		// The caller owns the write and the optimistic flip, so it needs to be told
		// which way to go rather than deriving it from a prop it is about to change.
		await user.click(screen.getByRole('button', { name: 'Remove from favorites' }));
		expect(onToggleFavorite).toHaveBeenCalledWith('target', false);
	});

	it("is disabled while ANY star is in flight, not just this slide's", () => {
		const { unmount } = render(MediaLightbox, {
			props: {
				media: makeImage({ id: 'in-flight' }),
				onClose: vi.fn(),
				onToggleFavorite: vi.fn(),
				favoritingId: 'in-flight',
			},
		});
		expect(screen.getByRole('button', { name: 'Add to favorites' })).toBeDisabled();
		unmount();

		// Another id in flight disables it too, because the caller's guard is a single
		// `if (favoritingId) return` — enabling the button here would accept a click
		// and silently discard it. (Contrast the delete button below, which keys on
		// this slide's id.)
		const other = render(MediaLightbox, {
			props: {
				media: makeImage({ id: 'this' }),
				onClose: vi.fn(),
				onToggleFavorite: vi.fn(),
				favoritingId: 'other',
			},
		});
		expect(screen.getByRole('button', { name: 'Add to favorites' })).toBeDisabled();
		other.unmount();

		// Nothing in flight: enabled.
		render(MediaLightbox, {
			props: { media: makeImage(), onClose: vi.fn(), onToggleFavorite: vi.fn() },
		});
		expect(screen.getByRole('button', { name: 'Add to favorites' })).toBeEnabled();
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

	it("puts an enhanced prompt's two regenerate choices behind one button", async () => {
		const user = userEvent.setup();
		const media = makeImage({ promptFull: 'enhanced sky', originalPrompt: 'sky' });
		render(MediaLightbox, { props: { media, onClose: vi.fn() } });

		// One button, so the row has the same shape enhanced or not.
		expect(screen.getAllByRole('button', { name: /^Regenerate/ })).toHaveLength(1);
		await user.click(screen.getByRole('button', { name: 'Regenerate with this prompt…' }));
		// Portaled to document.body — hence screen.*.
		await user.click(screen.getByRole('button', { name: /Your original prompt/ }));
		const stashed = JSON.parse(window.sessionStorage.getItem('glyphstream:galleryLaunch')!) as {
			prompt?: string;
		};
		expect(stashed.prompt).toBe('sky');
	});

	it('regenerates from the exact enhanced prompt when chosen from the menu', async () => {
		const user = userEvent.setup();
		const media = makeImage({ promptFull: 'enhanced sky', originalPrompt: 'sky' });
		render(MediaLightbox, { props: { media, onClose: vi.fn() } });

		await user.click(screen.getByRole('button', { name: 'Regenerate with this prompt…' }));
		await user.click(screen.getByRole('button', { name: /The enhanced prompt/ }));
		const stashed = JSON.parse(window.sessionStorage.getItem('glyphstream:galleryLaunch')!) as {
			prompt?: string;
		};
		expect(stashed.prompt).toBe('enhanced sky');
	});

	it('holds the action slots in place, hidden, on a carousel slide they do not apply to', () => {
		// A row whose buttons come and go per slide reflows, and the height change
		// resizes the image mid-swipe.
		const { container } = render(MediaLightbox, {
			props: {
				media: makeVideo({ id: 'm-2', promptFull: null, promptExcerpt: null }),
				onClose: vi.fn(),
				siblings: [
					{ id: 'm-1', kind: 'image' as const },
					{ id: 'm-2', kind: 'video' as const },
				],
				onNavigate: vi.fn(),
			},
		});
		// Hidden and inert, but still laid out.
		const held = container.querySelectorAll(
			'button[aria-label="Regenerate with this prompt"], button[aria-label="Use as starting image"]',
		);
		expect(held).toHaveLength(2);
		for (const b of held) {
			expect(b).toHaveClass('invisible');
			expect(b).toHaveAttribute('inert');
		}
	});

	it('Regenerate stashes the intent and navigates to /', async () => {
		const user = userEvent.setup();
		const onClose = vi.fn();
		const media = makeImage({
			promptFull: 'big sky',
			sourceEndpointId: 'bridge',
			sourceModel: 'bridge::flux-dev',
		});
		render(MediaLightbox, { props: { media, onClose } });
		await user.click(screen.getByRole('button', { name: 'Regenerate with this prompt' }));
		const stashed = JSON.parse(window.sessionStorage.getItem('glyphstream:galleryLaunch')!) as {
			prompt?: string;
			sourceModelId?: string | null;
		};
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
			sourceModel: 'bridge::flux-dev',
		});
		render(MediaLightbox, { props: { media, onClose: vi.fn() } });
		await user.click(screen.getByRole('button', { name: 'Regenerate with this prompt' }));
		const stashed = JSON.parse(window.sessionStorage.getItem('glyphstream:galleryLaunch')!) as {
			prompt?: string;
			sourceModelId?: string | null;
		};
		expect(stashed.prompt).toBe('excerpt only');
	});

	it('Use as starting image stashes the right intent', async () => {
		const user = userEvent.setup();
		const onClose = vi.fn();
		const media = makeImage({
			id: 'm-7',
			sourceEndpointId: 'bridge',
			sourceModel: 'bridge::flux-dev',
		});
		render(MediaLightbox, { props: { media, onClose } });
		await user.click(screen.getByRole('button', { name: 'Use as starting image' }));
		const stashed = JSON.parse(window.sessionStorage.getItem('glyphstream:galleryLaunch')!) as {
			prompt?: string;
			sourceModelId?: string | null;
		};
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
		const stashed = JSON.parse(window.sessionStorage.getItem('glyphstream:galleryLaunch')!) as {
			prompt?: string;
			sourceModelId?: string | null;
		};
		expect(stashed.sourceModelId).toBeNull();
	});

	it('composes the model id when a row stores a bare upstream id beside an endpoint', async () => {
		const user = userEvent.setup();
		const media = makeImage({
			sourceEndpointId: 'bridge',
			sourceModel: 'comfyui/sdxl',
		});
		render(MediaLightbox, { props: { media, onClose: vi.fn() } });
		await user.click(screen.getByRole('button', { name: 'Regenerate with this prompt' }));
		const stashed = JSON.parse(window.sessionStorage.getItem('glyphstream:galleryLaunch')!) as {
			sourceModelId?: string | null;
		};
		expect(stashed.sourceModelId).toBe('bridge::comfyui/sdxl');
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

/**
 * Wait out the lightbox's navigation coalescing window. Rapid navigation is
 * rate-limited (leading edge + trailing call) so that holding an arrow key
 * doesn't emit ~30 uncancelled metadata fetches a second for slides being flown
 * past; a second press inside the window therefore resolves on the trailing
 * edge rather than immediately.
 */
async function settleNavResolve() {
	await new Promise((r) => setTimeout(r, 200));
}

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
		// Leading edge — the first navigation resolves immediately, so the caption
		// and model panel stay responsive.
		expect(onNavigate).toHaveBeenCalledWith('m-3');
		await user.click(screen.getByRole('button', { name: 'Previous' }));
		// The second lands inside the coalescing window, so it arrives on the
		// trailing edge instead of firing its own metadata fetch immediately — and
		// it steps back from where the FIRST press went, landing where we started.
		//
		// `media` is a static prop here, so `currentIndex` never advances. Stepping
		// from it would make this 'm-1': every press inside the coalescing window
		// computing the same target, which is the bug this pins. A real parent
		// resolves `onNavigate` and feeds `media` back, and then Next-then-Previous
		// returns the user to where they started — 'm-2' is what the component
		// produces against a live parent, with or without the coalescer.
		await settleNavResolve();
		expect(onNavigate).toHaveBeenLastCalledWith('m-2');
	});

	it('disables Previous on the first item and Next on the last', () => {
		const { rerender } = render(MediaLightbox, {
			props: { media: makeImage({ id: 'm-1' }), onClose: vi.fn(), siblings, onNavigate: vi.fn() },
		});
		expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
		expect(screen.getByRole('button', { name: 'Next' })).not.toBeDisabled();

		void rerender({
			media: makeVideo({ id: 'm-3' }),
			onClose: vi.fn(),
			siblings,
			onNavigate: vi.fn(),
		});
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
		await settleNavResolve();
		// Steps back from the first press's target — see the Next/Previous test.
		expect(onNavigate).toHaveBeenLastCalledWith('m-2');
	});

	/**
	 * The point of the coalescer: a burst emits ONE trailing resolve, and it names
	 * the slide the user actually ended on. Stepping from `currentIndex` (which
	 * can't advance until the parent resolves) made every press in the window
	 * compute the same target, so a five-press burst moved two slides.
	 */
	it('a rapid burst resolves once, at the end of the burst', async () => {
		const user = userEvent.setup();
		const onNavigate = vi.fn();
		const many = Array.from({ length: 8 }, (_, i) => ({ id: `w-${i}`, kind: 'image' as const }));
		render(MediaLightbox, {
			props: { media: makeImage({ id: 'w-0' }), onClose: vi.fn(), siblings: many, onNavigate },
		});

		for (let i = 0; i < 5; i++) await user.keyboard('{ArrowRight}');
		await settleNavResolve();

		// Leading edge fired for the first press; everything after it collapsed into
		// one trailing call naming the final slide.
		expect(onNavigate).toHaveBeenCalledWith('w-1');
		expect(onNavigate).toHaveBeenLastCalledWith('w-5');
		expect(onNavigate.mock.calls.length).toBeLessThanOrEqual(2);
	});

	it('a burst still stops at the last slide', async () => {
		const user = userEvent.setup();
		const onNavigate = vi.fn();
		const many = Array.from({ length: 8 }, (_, i) => ({ id: `w-${i}`, kind: 'image' as const }));
		render(MediaLightbox, {
			props: { media: makeImage({ id: 'w-6' }), onClose: vi.fn(), siblings: many, onNavigate },
		});

		for (let i = 0; i < 5; i++) await user.keyboard('{ArrowRight}');
		await settleNavResolve();

		// Only one step was available; the rest are clamped, not wrapped.
		for (const [id] of onNavigate.mock.calls) expect(id).toBe('w-7');
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

/**
 * A swipe resolves the slide it's heading for at the midpoint, not once the
 * scroll settles. Waiting for the settle left the header describing the slide
 * the user had swiped away from for the whole snap animation plus a fetch: a lit
 * star over an unstarred image, and a star or trash button that acted on the
 * previous image if tapped in that gap.
 *
 * happy-dom does no layout, so the track's width and scroll offset are pinned
 * by hand and the scroll event fired directly.
 */
describe('MediaLightbox — swipe resolves at the midpoint', () => {
	const siblings = [
		{ id: 'm-1', kind: 'image' as const },
		{ id: 'm-2', kind: 'image' as const },
		{ id: 'm-3', kind: 'image' as const },
	];
	const WIDTH = 400;

	function track(container: HTMLElement) {
		const el = container.querySelector<HTMLDivElement>('.snap-x')!;
		let left = 0;
		Object.defineProperty(el, 'clientWidth', { configurable: true, get: () => WIDTH });
		Object.defineProperty(el, 'scrollLeft', {
			configurable: true,
			get: () => left,
			set: (v: number) => (left = v),
		});
		// Arrow navigation smooth-scrolls; the tests drive the scroll events.
		el.scrollTo = vi.fn();
		return {
			el,
			/** Scroll to `slides` slide-widths from the start and report it. */
			at(slides: number) {
				left = slides * WIDTH;
				void fireEvent.scroll(el);
			},
		};
	}

	it('resolves the next slide as soon as the swipe passes halfway', () => {
		const onNavigate = vi.fn();
		const { container } = render(MediaLightbox, {
			props: { media: makeImage({ id: 'm-1' }), onClose: vi.fn(), siblings, onNavigate },
		});
		const t = track(container);
		t.at(0.4);
		expect(onNavigate).not.toHaveBeenCalled();
		t.at(0.6);
		// No timers advanced: this is the midpoint, not the settle.
		expect(onNavigate).toHaveBeenCalledWith('m-2');
		expect(screen.getByText('2 / 3')).toBeInTheDocument();
	});

	it("disables the previous slide's actions until the new one resolves", () => {
		const props = {
			media: makeImage({ id: 'm-1', favorite: true }),
			onClose: vi.fn(),
			siblings,
			onNavigate: vi.fn(),
			onToggleFavorite: vi.fn(),
			onDelete: vi.fn(),
		};
		const { container, rerender } = render(MediaLightbox, { props });
		track(container).at(0.6);

		// Still holding m-1's row: its lit star would be a claim about an image the
		// user has left, and tapping it would star m-1.
		const star = screen.getByRole('button', { name: 'Add to favorites' });
		expect(star).toBeDisabled();
		expect(star).toHaveAttribute('aria-pressed', 'false');
		expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();

		void rerender({ ...props, media: makeImage({ id: 'm-2', favorite: false }) });
		expect(screen.getByRole('button', { name: 'Add to favorites' })).not.toBeDisabled();
		expect(screen.getByRole('button', { name: 'Delete' })).not.toBeDisabled();
	});

	it('re-asks for the shown slide when a drag past halfway comes back', async () => {
		const onNavigate = vi.fn();
		const { container } = render(MediaLightbox, {
			props: { media: makeImage({ id: 'm-1' }), onClose: vi.fn(), siblings, onNavigate },
		});
		const t = track(container);
		t.at(0.6);
		expect(onNavigate).toHaveBeenLastCalledWith('m-2');
		t.at(0.2);
		await settleNavResolve();
		// The m-2 resolve already went out, and a caller may still be fetching it.
		// Settling back on m-1 has to supersede it, or its response would move
		// `media` to m-2 under a track resting on m-1.
		expect(onNavigate).toHaveBeenLastCalledWith('m-1');
	});

	// The trash's Restore steps `media` to a neighbour itself. Left on the restored
	// slide, the track's next scroll event read as a swipe back to it — and once
	// the reload dropped that item, the lightbox closed.
	it('follows media when the caller moves it, so the next scroll does not drag it back', async () => {
		const onNavigate = vi.fn();
		const props = { media: makeImage({ id: 'm-1' }), onClose: vi.fn(), siblings, onNavigate };
		const { container, rerender } = render(MediaLightbox, { props });
		const t = track(container);
		void rerender({ ...props, media: makeImage({ id: 'm-3' }) });
		await tick();
		expect(t.el.scrollTo).toHaveBeenCalledWith({ left: 2 * WIDTH, behavior: 'auto' });
		t.at(2);
		await settleNavResolve();
		expect(onNavigate).not.toHaveBeenCalled();
	});

	it('keeps the track on the open item when a reload drops a slide before it', async () => {
		const props = {
			media: makeImage({ id: 'm-2' }),
			onClose: vi.fn(),
			siblings,
			onNavigate: vi.fn(),
		};
		const { container, rerender } = render(MediaLightbox, { props });
		const t = track(container);
		t.el.scrollLeft = WIDTH;
		void rerender({ ...props, siblings: siblings.slice(1) });
		await tick();
		expect(t.el.scrollTo).toHaveBeenCalledWith({ left: 0, behavior: 'auto' });
	});

	it("doesn't let an arrow burst's smooth scroll pull it back slide by slide", async () => {
		const user = userEvent.setup();
		const onNavigate = vi.fn();
		const many = Array.from({ length: 6 }, (_, i) => ({ id: `w-${i}`, kind: 'image' as const }));
		const { container } = render(MediaLightbox, {
			props: { media: makeImage({ id: 'w-0' }), onClose: vi.fn(), siblings: many, onNavigate },
		});
		const t = track(container);
		for (let i = 0; i < 3; i++) await user.keyboard('{ArrowRight}');
		// The animation toward w-3 passes w-1 and w-2 on the way, emitting scroll
		// events throughout (so the settle doesn't fire) and spending longer than
		// the coalescing window there. Treated as a swipe, that would pull the
		// burst's target back and resolve w-2 on the trailing edge.
		for (const pos of [1, 1.5, 2, 2, 2, 2, 2, 2.3, 2.7, 3]) {
			t.at(pos);
			await new Promise((r) => setTimeout(r, 30));
		}
		await settleNavResolve();
		expect(onNavigate).toHaveBeenLastCalledWith('w-3');
		expect(onNavigate).not.toHaveBeenCalledWith('w-2');
	});

	it("doesn't wait on an arrow scroll that won't move the track", async () => {
		const user = userEvent.setup();
		const onNavigate = vi.fn();
		const { container } = render(MediaLightbox, {
			props: { media: makeImage({ id: 'm-1' }), onClose: vi.fn(), siblings, onNavigate },
		});
		const t = track(container);
		// The track already rests where the press will send it, so its scrollTo is
		// a no-op that emits no scroll event to say it arrived.
		t.el.scrollLeft = WIDTH;
		await user.keyboard('{ArrowRight}');
		onNavigate.mockClear();
		await settleNavResolve();
		// The next swipe still resolves at its midpoint.
		t.at(1.6);
		expect(onNavigate).toHaveBeenCalledWith('m-3');
	});

	it("drops an earlier press's target when a later press cancels its scroll", async () => {
		const user = userEvent.setup();
		const onNavigate = vi.fn();
		const { container } = render(MediaLightbox, {
			props: { media: makeImage({ id: 'm-1' }), onClose: vi.fn(), siblings, onNavigate },
		});
		const t = track(container);
		// Right then Left before the first animation frame: the track never left
		// slide 0, and the second scrollTo (to where it already is) cancels the
		// first's smooth scroll toward slide 1.
		await user.keyboard('{ArrowRight}');
		await user.keyboard('{ArrowLeft}');
		// Twice: the burst's trailing resolve reopens the coalescing window, and a
		// swipe inside it would be deferred to the settle whatever the target.
		await settleNavResolve();
		await settleNavResolve();
		onNavigate.mockClear();
		t.at(0.6);
		// Synchronously, i.e. at the midpoint rather than at the settle — which
		// would resolve m-2 anyway and hide the stale target.
		expect(onNavigate).toHaveBeenCalledWith('m-2');
	});

	it('finishes the snap when a flick comes to rest between slides', async () => {
		const { container } = render(MediaLightbox, {
			props: { media: makeImage({ id: 'm-1' }), onClose: vi.fn(), siblings, onNavigate: vi.fn() },
		});
		const t = track(container);
		// A flick: the finger lifts early, and the midpoint swap lands during the
		// browser's snap animation — which iOS can then drop, leaving the track
		// partway onto the slide after.
		await fireEvent.touchStart(t.el);
		t.at(0.3);
		await fireEvent.touchEnd(t.el);
		t.at(0.6);
		t.at(1.2);
		await settleNavResolve();
		expect(t.el.scrollTo).toHaveBeenCalledWith({ left: WIDTH, behavior: 'smooth' });
	});

	it('leaves a track the finger is still holding between slides alone', async () => {
		const { container } = render(MediaLightbox, {
			props: { media: makeImage({ id: 'm-1' }), onClose: vi.fn(), siblings, onNavigate: vi.fn() },
		});
		const t = track(container);
		await fireEvent.touchStart(t.el);
		t.at(0.7);
		await settleNavResolve();
		expect(t.el.scrollTo).not.toHaveBeenCalled();
	});

	it("doesn't re-snap a track the browser already snapped", async () => {
		const { container } = render(MediaLightbox, {
			props: { media: makeImage({ id: 'm-1' }), onClose: vi.fn(), siblings, onNavigate: vi.fn() },
		});
		const t = track(container);
		await fireEvent.touchStart(t.el);
		t.at(0.3);
		await fireEvent.touchEnd(t.el);
		t.at(1);
		await settleNavResolve();
		expect(t.el.scrollTo).not.toHaveBeenCalled();
	});

	it('leaves the page alone while a flick coasts, and resolves where it lands', async () => {
		const onNavigate = vi.fn();
		const { container } = render(MediaLightbox, {
			props: { media: makeImage({ id: 'm-1' }), onClose: vi.fn(), siblings, onNavigate },
		});
		const t = track(container);
		await fireEvent.touchStart(t.el);
		t.at(0.3);
		await fireEvent.touchEnd(t.el);
		// Past halfway on momentum: a DOM change now is what made iOS drop the snap.
		t.at(0.6);
		t.at(0.9);
		expect(onNavigate).not.toHaveBeenCalled();
		expect(screen.getByText('1 / 3')).toBeInTheDocument();
		t.at(1);
		await settleNavResolve();
		expect(onNavigate).toHaveBeenCalledWith('m-2');
	});

	it('still resolves at the midpoint while the finger is down', async () => {
		const onNavigate = vi.fn();
		const { container } = render(MediaLightbox, {
			props: { media: makeImage({ id: 'm-1' }), onClose: vi.fn(), siblings, onNavigate },
		});
		const t = track(container);
		await fireEvent.touchStart(t.el);
		t.at(0.6);
		expect(onNavigate).toHaveBeenCalledWith('m-2');
	});

	it("doesn't let a tap arm the re-snap for a later non-touch scroll", async () => {
		const { container } = render(MediaLightbox, {
			props: { media: makeImage({ id: 'm-1' }), onClose: vi.fn(), siblings, onNavigate: vi.fn() },
		});
		const t = track(container);
		await fireEvent.touchStart(t.el);
		await fireEvent.touchEnd(t.el);
		await settleNavResolve();
		// A trackpad swipe, paused partway with the fingers still on the pad.
		t.at(0.3);
		await settleNavResolve();
		expect(t.el.scrollTo).not.toHaveBeenCalled();
	});

	it("doesn't let a hold that lifts on a slide arm it either", async () => {
		const { container } = render(MediaLightbox, {
			props: { media: makeImage({ id: 'm-1' }), onClose: vi.fn(), siblings, onNavigate: vi.fn() },
		});
		const t = track(container);
		// Dragged, held long enough for the settle to pass, lifted with nothing
		// moving after — no settle follows to consume the release.
		await fireEvent.touchStart(t.el);
		t.at(0.3);
		t.at(1);
		await settleNavResolve();
		await fireEvent.touchEnd(t.el);
		await settleNavResolve();
		t.at(1.3);
		await settleNavResolve();
		expect(t.el.scrollTo).not.toHaveBeenCalled();
	});

	it('re-snaps a flick that lifts before its first scroll event', async () => {
		const { container } = render(MediaLightbox, {
			props: { media: makeImage({ id: 'm-1' }), onClose: vi.fn(), siblings, onNavigate: vi.fn() },
		});
		const t = track(container);
		// Scroll events are per-frame and `touchend` isn't, so the shortest flick
		// reports its lift first.
		await fireEvent.touchStart(t.el);
		await fireEvent.touchEnd(t.el);
		t.at(0.6);
		t.at(1.2);
		await settleNavResolve();
		expect(t.el.scrollTo).toHaveBeenCalledWith({ left: WIDTH, behavior: 'smooth' });
	});

	it('asks the caller to prefetch the slides either side', () => {
		const onPrefetch = vi.fn();
		render(MediaLightbox, {
			props: {
				media: makeImage({ id: 'm-2' }),
				onClose: vi.fn(),
				siblings,
				onNavigate: vi.fn(),
				onPrefetch,
			},
		});
		expect(onPrefetch.mock.calls.map(([id]) => id as string).sort()).toEqual(['m-1', 'm-3']);
	});

	it("doesn't prefetch every slide a held arrow key flies past", async () => {
		const user = userEvent.setup();
		const onPrefetch = vi.fn();
		const many = Array.from({ length: 10 }, (_, i) => ({ id: `w-${i}`, kind: 'image' as const }));
		render(MediaLightbox, {
			props: {
				media: makeImage({ id: 'w-0' }),
				onClose: vi.fn(),
				siblings: many,
				onNavigate: vi.fn(),
				onPrefetch,
			},
		});
		// `media` is static, as if no resolve has landed yet: the presses move only
		// where the user has navigated to. Prefetching follows resolves, which the
		// coalescer rate-limits, not keypresses.
		for (let i = 0; i < 6; i++) await user.keyboard('{ArrowRight}');
		expect(onPrefetch.mock.calls.map(([id]) => id as string)).toEqual(['w-1']);
	});

	it('keeps the prompt strip in place for a slide with no prompt', () => {
		render(MediaLightbox, {
			props: {
				media: makeImage({ id: 'm-1', promptExcerpt: null, promptFull: null }),
				onClose: vi.fn(),
				siblings,
				onNavigate: vi.fn(),
			},
		});
		// Swapping at the midpoint means the slide is still moving when the strip
		// changes; a strip that came and went would resize the image under it.
		expect(screen.getByTestId('lightbox-prompt')).toBeInTheDocument();
	});
});

describe('MediaLightbox — slide windowing', () => {
	/**
	 * `siblings` is every unit demand-loaded this gallery session, so after a deep
	 * scroll the carousel track was mounting thousands of full-resolution <img>
	 * elements at once. `loading="lazy"` stops them all being fetched, but they're
	 * still elements the browser must create, style and lay out on open.
	 *
	 * The slot divs have to stay — the track is scroll-snap and `onTrackScroll`
	 * maps scroll offset back to an index, so slicing the array would shift every
	 * index — but only the media near the current slide is mounted.
	 */
	const many = Array.from({ length: 400 }, (_, i) => ({ id: `w-${i}`, kind: 'image' as const }));

	it('mounts only the slides near the current one', () => {
		const { container } = render(MediaLightbox, {
			props: {
				media: makeImage({ id: 'w-200' }),
				onClose: vi.fn(),
				siblings: many,
				onNavigate: vi.fn(),
			},
		});
		const imgs = container.querySelectorAll('img[src*="/api/media/"]');
		// Window is +/-2 around the current index, so at most a handful — and
		// crucially a constant, not 400.
		expect(imgs.length).toBeLessThanOrEqual(6);
		// The slots themselves are all still present, so scroll geometry is intact.
		const slots = container.querySelectorAll('.snap-always');
		expect(slots.length).toBe(400);
	});

	it('loads the current slide eagerly and its neighbours lazily', () => {
		const { container } = render(MediaLightbox, {
			props: {
				media: makeImage({ id: 'w-200' }),
				onClose: vi.fn(),
				siblings: many,
				onNavigate: vi.fn(),
			},
		});
		const eager = container.querySelectorAll('img[loading="eager"]');
		expect(eager.length, 'exactly one slide should load eagerly').toBe(1);
		expect(eager[0].getAttribute('src')).toContain('w-200');
		expect(eager[0].getAttribute('fetchpriority')).toBe('high');
	});
});

/**
 * "Set as avatar". The component stays presentational — it decides WHETHER to
 * offer the action and which shape it takes, and hands the change to the
 * caller (same division as onDelete).
 */
describe('MediaLightbox — set as avatar', () => {
	const preset = (
		over: Partial<{ id: string; name: string; avatarMediaId: string | null }> = {},
	) => ({
		kind: 'preset' as const,
		id: over.id ?? 'cm-1',
		name: over.name ?? 'Ilya',
		avatarMediaId: over.avatarMediaId ?? null,
	});

	it('offers nothing when the user has no presets', () => {
		render(MediaLightbox, {
			props: { media: makeImage(), onClose: vi.fn(), onSetAvatar: vi.fn(), avatarTargets: [] },
		});
		expect(screen.queryByRole('button', { name: /avatar/i })).not.toBeInTheDocument();
	});

	it('offers nothing for a video', () => {
		// The avatar surfaces render an <img>; a video has no still to stand in.
		render(MediaLightbox, {
			props: {
				media: makeVideo(),
				onClose: vi.fn(),
				onSetAvatar: vi.fn(),
				avatarTargets: [preset()],
			},
		});
		expect(screen.queryByRole('button', { name: /avatar/i })).not.toBeInTheDocument();
	});

	it('names the preset in the button when there is exactly one', async () => {
		const user = userEvent.setup();
		const onSetAvatar = vi.fn();
		render(MediaLightbox, {
			props: {
				media: makeImage({ id: 'm-9' }),
				onClose: vi.fn(),
				onSetAvatar,
				avatarTargets: [preset({ id: 'cm-7', name: 'Ilya' })],
			},
		});

		// One option needs no menu — a click to open a list of one is a wasted click.
		await user.click(screen.getByRole('button', { name: 'Set as avatar for Ilya' }));
		expect(onSetAvatar).toHaveBeenCalledWith({ kind: 'preset', id: 'cm-7' }, 'm-9');
	});

	it('disables the single-preset button when this image is already the avatar', () => {
		render(MediaLightbox, {
			props: {
				media: makeImage({ id: 'm-9' }),
				onClose: vi.fn(),
				onSetAvatar: vi.fn(),
				avatarTargets: [preset({ name: 'Ilya', avatarMediaId: 'm-9' })],
			},
		});
		expect(screen.getByRole('button', { name: 'Avatar for Ilya' })).toBeDisabled();
	});

	it('opens a picker when there is more than one preset', async () => {
		const user = userEvent.setup();
		const onSetAvatar = vi.fn();
		render(MediaLightbox, {
			props: {
				media: makeImage({ id: 'm-9' }),
				onClose: vi.fn(),
				onSetAvatar,
				avatarTargets: [
					preset({ id: 'cm-1', name: 'Ilya' }),
					preset({ id: 'cm-2', name: 'Marta', avatarMediaId: 'm-other' }),
				],
			},
		});

		await user.click(screen.getByRole('button', { name: 'Set as avatar…' }));
		// Portaled to document.body — hence screen.*, not container.querySelector.
		await user.click(screen.getByRole('button', { name: 'Marta' }));
		expect(onSetAvatar).toHaveBeenCalledWith({ kind: 'preset', id: 'cm-2' }, 'm-9');
	});

	it('Escape closes the open picker without also closing the lightbox', async () => {
		const user = userEvent.setup();
		const onClose = vi.fn();
		render(MediaLightbox, {
			props: {
				media: makeImage({ id: 'm-9' }),
				onClose,
				onSetAvatar: vi.fn(),
				avatarTargets: [
					preset({ id: 'cm-1', name: 'Ilya' }),
					preset({ id: 'cm-2', name: 'Marta' }),
				],
			},
		});

		await user.click(screen.getByRole('button', { name: 'Set as avatar…' }));
		expect(screen.getByRole('button', { name: 'Marta' })).toBeInTheDocument();
		await user.keyboard('{Escape}');
		expect(onClose).not.toHaveBeenCalled();
		// A second Escape, with the picker gone, closes the lightbox as usual.
		await user.keyboard('{Escape}');
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('marks the preset already using this image and lets the others through', async () => {
		const user = userEvent.setup();
		const onSetAvatar = vi.fn();
		render(MediaLightbox, {
			props: {
				media: makeImage({ id: 'm-9' }),
				onClose: vi.fn(),
				onSetAvatar,
				avatarTargets: [
					preset({ id: 'cm-1', name: 'Ilya', avatarMediaId: 'm-9' }),
					preset({ id: 'cm-2', name: 'Marta' }),
				],
			},
		});

		await user.click(screen.getByRole('button', { name: 'Set as avatar…' }));
		expect(screen.getByRole('button', { name: 'Ilya' })).toBeDisabled();
		expect(screen.getByRole('button', { name: 'Marta' })).toBeEnabled();
	});
});

/**
 * Triage mode: the open image is in the media fan-out grid on screen, and the
 * action row becomes that grid's footer.
 */
describe('MediaLightbox — triaging a fan-out grid', () => {
	const base = () => ({
		media: makeImage({ id: 'g1', promptFull: 'a lighthouse', originalPrompt: 'lighthouse' }),
		onClose: vi.fn(),
		inConversation: true,
		onToggleFavorite: vi.fn(),
		onDelete: vi.fn(),
		onSetAvatar: vi.fn(),
		avatarTargets: [{ kind: 'preset' as const, id: 'cm-1', name: 'Ilya', avatarMediaId: null }],
	});

	it('offers the grid’s actions in place of the usual row and the corner pair', async () => {
		const user = userEvent.setup();
		const props = base();
		const onRegenerate = vi.fn();
		render(MediaLightbox, { props: { ...props, triage: { onRegenerate } } });

		// One star and one trash: the corner's give way to the row's.
		expect(screen.getAllByRole('button', { name: 'Add to favorites' })).toHaveLength(1);
		expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(1);
		// "Regenerate" means only the grid's re-roll here.
		expect(screen.queryByRole('button', { name: /Regenerate in a new chat/ })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Edit in a new chat' })).toBeNull();
		expect(screen.queryByRole('button', { name: /avatar/i })).toBeNull();

		await user.click(screen.getByRole('button', { name: 'Regenerate' }));
		expect(onRegenerate).toHaveBeenCalledWith('g1');
		await user.click(screen.getByRole('button', { name: 'Add to favorites' }));
		expect(props.onToggleFavorite).toHaveBeenCalledWith('g1', true);
		await user.click(screen.getByRole('button', { name: 'Delete' }));
		expect(props.onDelete).toHaveBeenCalledWith('g1');
	});

	it('offers an avatar comparison’s pick alongside', async () => {
		const user = userEvent.setup();
		const onPick = vi.fn();
		render(MediaLightbox, {
			props: { ...base(), triage: { onRegenerate: vi.fn(), onPick, pickLabel: 'Use this avatar' } },
		});
		await user.click(screen.getByRole('button', { name: 'Use this avatar' }));
		expect(onPick).toHaveBeenCalledWith('g1');
	});

	it('keeps the trash, disabled, where the grid won’t discard', () => {
		// The grid's last column: it keeps at least one.
		render(MediaLightbox, {
			props: { ...base(), onDelete: undefined, triage: { onRegenerate: vi.fn() } },
		});
		expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
	});

	it('disables Regenerate at the grid’s in-flight cap, and withholds it where there’s nothing to re-roll', () => {
		const { unmount } = render(MediaLightbox, {
			props: { ...base(), triage: { onRegenerate: vi.fn(), regenerateBlocked: true } },
		});
		expect(screen.getByRole('button', { name: 'Regenerate' })).toBeDisabled();
		unmount();
		render(MediaLightbox, { props: { ...base(), triage: {} } });
		expect(screen.queryByRole('button', { name: 'Regenerate' })).toBeNull();
	});
});
