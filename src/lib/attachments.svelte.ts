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

import type { ModelKind } from '$lib/types/api';

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

	/** Reset the store to empty, revoking any blob URLs. */
	clear(): void {
		for (const it of this.items) {
			URL.revokeObjectURL(it.objectUrl);
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

	private async addOne(file: File): Promise<void> {
		// Soft-skip non-images. The hidden input has accept="image/*" but
		// drag-drop and paste paths can drop arbitrary types — better to
		// quietly ignore than to surface an error for every PDF that
		// crosses the drop zone.
		if (!file.type.startsWith('image/')) return;

		const clientId = crypto.randomUUID();
		const objectUrl = URL.createObjectURL(file);
		const initial: AttachedItem = {
			clientId,
			mediaId: null,
			objectUrl,
			contentType: file.type,
			byteSize: file.size,
			status: 'uploading'
		};
		this.items = [...this.items, initial];

		try {
			const fd = new FormData();
			fd.append('file', file);
			const res = await fetch('/api/uploads', { method: 'POST', body: fd });
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error((body as { message?: string }).message ?? `HTTP ${res.status}`);
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
		if (it) URL.revokeObjectURL(it.objectUrl);
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
