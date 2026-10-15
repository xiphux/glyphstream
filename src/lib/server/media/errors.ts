/**
 * Media errors, in a leaf module with no imports so a caller that only needs
 * to recognise one (the upstream serializer) doesn't pull in the disk store
 * and the vision-variant encoder to get it.
 */

/**
 * Thrown by `loadMediaBytes` when the media is permanently unavailable:
 * row not found, deleted (trashed or purged), wrong kind, or file missing from disk
 * (ENOENT). Catchers in the send path use this to degrade gracefully
 * rather than crash the whole request. Transient disk I/O errors
 * (EACCES, EIO, …) still propagate as raw `Error`s — a blanket catch
 * would incorrectly tell the model an image was deleted when it was
 * merely momentarily unreadable.
 */
export class MediaNotAvailableError extends Error {
	constructor(mediaId: string, detail: string) {
		super(`Media ${mediaId} is not available: ${detail}`);
		this.name = 'MediaNotAvailableError';
	}
}
