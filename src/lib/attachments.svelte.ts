/**
 * Reactive store for composer image attachments.
 *
 * The store eagerly POSTs each picked file to `/api/uploads` and tracks
 * per-file status so the UI can show real progress / errors. Attached
 * thumbnails use the local blob URL until the server-side media id is
 * known; on send, the parent reads `readyMediaIds` and forwards them.
 *
 * Eager upload trades a small "abandoned upload" cost (file picked but
 * message never sent → orphan media row) for a much better UX. The
 * server-side purger sweeps abandoned rows after the grace period — see
 * the comment on insertMedia for origin='uploaded'.
 */

import { untrack } from 'svelte';
import type { ModelKind } from '$lib/types/api';

// --- client-side image resize -------------------------------------------
//
// Why: vision models internally downscale to ~768/1024 px anyway, so a
// raw 5 MB iPhone photo is wasted bandwidth — and reverse proxies in
// front of self-hosted deploys often have low default request-body
// limits (Synology's nginx defaults to 1 MB) that reject large uploads
// long before they reach GlyphStream. Re-encoding to a JPEG capped at
// ~1568 px / quality 0.85 keeps every upload well under any sensible
// proxy limit AND makes the network round trip faster.
//
// What we skip:
//   - files already small enough to slip under typical proxy defaults
//     (re-encoding small PNGs/screenshots would be lossy for no win)
//   - animated formats (GIF) where re-encoding collapses to a single frame
//   - vector formats (SVG) — canvas would rasterize at an arbitrary size
//   - HEIC/HEIF — only Safari can natively decode these in a canvas, and
//     even there reliability varies. iPhone Safari typically auto-converts
//     to JPEG at <input type="file"> picker time anyway, so this is rare.

const RESIZE_SKIP_BELOW_BYTES = 500 * 1024;
const RESIZE_SKIP_TYPES = new Set([
	'image/gif',
	'image/svg+xml',
	'image/heic',
	'image/heif'
]);
const RESIZE_MAX_DIMENSION = 1568;
const RESIZE_JPEG_QUALITY = 0.85;

/** Best-effort image resize. Returns the original file if resize is
 * skipped or fails — never throws, since "upload as-is" is a strictly
 * better fallback than "drop the upload." */
async function maybeResize(file: File): Promise<File> {
	if (file.size < RESIZE_SKIP_BELOW_BYTES) return file;
	if (RESIZE_SKIP_TYPES.has(file.type.toLowerCase())) return file;

	let objectUrl: string | null = null;
	try {
		objectUrl = URL.createObjectURL(file);
		const img = await new Promise<HTMLImageElement>((resolve, reject) => {
			const i = new Image();
			i.onload = () => resolve(i);
			i.onerror = () => reject(new Error('image decode failed'));
			i.src = objectUrl!;
		});

		const scale = Math.min(1, RESIZE_MAX_DIMENSION / Math.max(img.width, img.height));
		const w = Math.max(1, Math.round(img.width * scale));
		const h = Math.max(1, Math.round(img.height * scale));

		const canvas = document.createElement('canvas');
		canvas.width = w;
		canvas.height = h;
		const ctx = canvas.getContext('2d');
		if (!ctx) return file;
		// White background — JPEG has no alpha channel, so transparent
		// source pixels would otherwise become black. White is the
		// neutral choice for images destined for vision models.
		ctx.fillStyle = '#fff';
		ctx.fillRect(0, 0, w, h);
		ctx.drawImage(img, 0, 0, w, h);

		const blob = await new Promise<Blob | null>((resolve) =>
			canvas.toBlob(resolve, 'image/jpeg', RESIZE_JPEG_QUALITY)
		);
		if (!blob) return file;
		// If for some reason the "resized" blob is larger than the
		// source (unlikely but possible for already-compressed inputs),
		// keep the smaller original.
		if (blob.size >= file.size) return file;

		const baseName = file.name.replace(/\.[^.]+$/, '') || 'upload';
		return new File([blob], `${baseName}.jpg`, { type: 'image/jpeg' });
	} catch {
		return file;
	} finally {
		if (objectUrl) URL.revokeObjectURL(objectUrl);
	}
}

export interface AttachedItem {
	/** Stable client-side id for keyed list rendering + bookkeeping. */
	clientId: string;
	/** Server-side media id once /api/uploads responds. Null while uploading. */
	mediaId: string | null;
	/** Local blob URL for the thumbnail. Revoked on remove + on store destroy. */
	objectUrl: string;
	contentType: string;
	byteSize: number;
	status: 'uploading' | 'ready' | 'error';
	error?: string;
}

interface UploadResponse {
	id: string;
	contentType: string;
	byteSize: number;
	kind: 'image';
}

export class AttachmentStore {
	items = $state<AttachedItem[]>([]);

	/**
	 * Reset the store to empty, revoking any blob URLs.
	 *
	 * The blob-URL revoke loop reads `this.items` once. We untrack that
	 * read so callers invoking clear() from within an `$effect` don't
	 * inadvertently pick up `items` as a reactive dependency — that
	 * combined with another effect writing `items` (e.g. auto-attach)
	 * would create a clear → write → clear → write infinite loop.
	 */
	clear(): void {
		const snapshot = untrack(() => this.items);
		for (const it of snapshot) {
			if (it.objectUrl.startsWith('blob:')) {
				URL.revokeObjectURL(it.objectUrl);
			}
		}
		this.items = [];
	}

	/** Per-page cleanup (call from onDestroy or equivalent). */
	destroy(): void {
		this.clear();
	}

	/** Media ids ready to be forwarded to the message-send call. */
	readyMediaIds(): string[] {
		return this.items
			.filter((it) => it.status === 'ready' && it.mediaId !== null)
			.map((it) => it.mediaId!);
	}

	/** True if any attachment is still uploading — disable Send until resolved. */
	get isBusy(): boolean {
		return this.items.some((it) => it.status === 'uploading');
	}

	/** True if any attachment failed — parent can surface a banner. */
	get hasErrors(): boolean {
		return this.items.some((it) => it.status === 'error');
	}

	async addFiles(files: FileList | File[]): Promise<void> {
		const arr = Array.from(files);
		await Promise.all(arr.map((f) => this.addOne(f)));
	}

	/**
	 * Attach a media row that already exists on the server — used for the
	 * auto-attach-last-generated-image flow on I2I follow-ups. Skips the
	 * upload entirely; the thumbnail is served straight from
	 * /api/media/{id}/content.
	 */
	attachExisting(
		mediaId: string,
		opts: { contentType?: string; byteSize?: number } = {}
	): void {
		this.items = [
			...this.items,
			{
				clientId: crypto.randomUUID(),
				mediaId,
				objectUrl: `/api/media/${mediaId}/content`,
				contentType: opts.contentType ?? 'image/*',
				byteSize: opts.byteSize ?? 0,
				status: 'ready'
			}
		];
	}

	private async addOne(file: File): Promise<void> {
		// Soft-skip non-images. The hidden input has accept="image/*" but
		// drag-drop and paste paths can drop arbitrary types — better to
		// quietly ignore than to surface an error for every PDF that
		// crosses the drop zone.
		if (!file.type.startsWith('image/')) return;

		// Resize before creating the UI item so the thumbnail's objectUrl
		// and the byteSize match what's actually being uploaded. The
		// resize is bounded by image decode + canvas draw — typically
		// <300ms even on a slow phone for a multi-MB photo. If a future
		// us cares about showing progress here, the move would be to
		// push a "decoding" status item first then swap it for the
		// resized version.
		const uploadFile = await maybeResize(file);

		const clientId = crypto.randomUUID();
		const objectUrl = URL.createObjectURL(uploadFile);
		const initial: AttachedItem = {
			clientId,
			mediaId: null,
			objectUrl,
			contentType: uploadFile.type,
			byteSize: uploadFile.size,
			status: 'uploading'
		};
		this.items = [...this.items, initial];

		try {
			const fd = new FormData();
			fd.append('file', uploadFile);
			const res = await fetch('/api/uploads', { method: 'POST', body: fd });
			if (!res.ok) {
				const body = await res.json().catch(() => null);
				// A non-JSON body on a 4xx is the classic reverse-proxy
				// signature (HTML error page from nginx etc.) — our own
				// route always responds with structured JSON. Surface that
				// hint so future you knows to check the proxy, not the app.
				const msg = (body as { message?: string } | null)?.message;
				const proxyHint =
					!body && (res.status === 413 || res.status === 400)
						? ' (likely the reverse proxy rejecting the body — check its size limit)'
						: '';
				throw new Error((msg ?? `HTTP ${res.status}`) + proxyHint);
			}
			const body = (await res.json()) as UploadResponse;
			this.items = this.items.map((it) =>
				it.clientId === clientId ? { ...it, mediaId: body.id, status: 'ready' as const } : it
			);
		} catch (e) {
			this.items = this.items.map((it) =>
				it.clientId === clientId
					? {
							...it,
							status: 'error' as const,
							error: e instanceof Error ? e.message : String(e)
						}
					: it
			);
		}
	}

	remove(clientId: string): void {
		const it = this.items.find((i) => i.clientId === clientId);
		// Only blob URLs need revoking; server-side URLs (auto-attached
		// existing media) are no-ops for revokeObjectURL but better to
		// guard than to call needlessly.
		if (it && it.objectUrl.startsWith('blob:')) {
			URL.revokeObjectURL(it.objectUrl);
		}
		this.items = this.items.filter((i) => i.clientId !== clientId);
	}
}

/**
 * Whether attachments make sense for a given model kind. The composer's
 * `+` button hides for kinds where attaching wouldn't go anywhere useful
 * (embedding models can't take images).
 *
 * Vision support inside `chat` kind is per-model, not per-kind, so we
 * return true for all chat models and let the upstream reject if the
 * specific model isn't multimodal. The UX cost of the false positive is
 * small (the user sees an upstream error); the alternative is per-model
 * capability metadata we don't have yet.
 */
export function attachmentsAllowedFor(kind: ModelKind | null): boolean {
	if (!kind) return true;
	return kind === 'chat' || kind === 'image' || kind === 'video';
}
