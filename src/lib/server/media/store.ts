/**
 * MediaStore — abstraction over how generated media bytes are stored.
 *
 * v1 ships only DiskMediaStore. v2's S3MediaStore (Backblaze B2 / R2 /
 * MinIO) implements the same interface against AWS SDK; no data migration
 * needed when we swap.
 *
 * Range support is first-class because mp4 playback on iOS Safari requires
 * 206 Partial Content responses.
 */

import type { Readable } from 'node:stream';

export interface MediaStoredRef {
	storagePath: string;
	byteSize: number;
	contentType: string;
}

export interface MediaPutInput {
	bytes: Buffer;
	contentType: string;
	kind: 'image' | 'video';
}

/** What `open()` returns — body + status info for serving the bytes. */
export interface MediaOpenResult {
	stream: Readable;
	contentLength: number;
	contentRange?: { start: number; end: number; total: number };
	contentType: string;
}

/** Range request from the HTTP layer. Bounds are inclusive (HTTP convention). */
export interface MediaRange {
	start: number;
	end: number;
}

export interface MediaStore {
	/** Persist `bytes` and return where it landed. Atomic on disk via tmp+rename. */
	put(input: MediaPutInput): Promise<MediaStoredRef>;
	/**
	 * Open a stored asset for reading. Honors `range` for partial content
	 * (clamped to the file's length). Returns null if the asset is missing.
	 */
	open(
		storagePath: string,
		contentType: string,
		range?: MediaRange
	): Promise<MediaOpenResult | null>;
	/** Best-effort delete; missing files don't error. */
	delete(storagePath: string): Promise<void>;
}
