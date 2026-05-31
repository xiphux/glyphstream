/**
 * Upload classification — given a content type, decide whether the upload
 * is accepted at all, what `media.kind` it lands under, and what size cap
 * applies. Pulled out of the route handler so the rules can be unit-tested
 * directly without spinning up a SvelteKit request.
 *
 * Image and video uploads ride the existing AV pipeline (image-edit /
 * video-input-reference / vision data URLs). File uploads (`kind: 'file'`)
 * are the code-interpreter feeder — anything the model might want to
 * analyze with Python (xlsx, csv, pdf, json, txt, ...). The allowlist
 * for the latter is intentionally enumerated rather than "everything
 * non-image" so a new accepted type is an explicit, reviewable change
 * here, not an accident of MIME prefixes.
 *
 * Keep this in sync with the composer's `ATTACHMENT_ACCEPT` constant —
 * drift in either direction is the canonical "user picks something the
 * server rejects" / "server quietly accepts something the picker hides"
 * footgun.
 */

import type { MediaKind } from '$lib/server/db/queries/media';

/** Photos can be large (full-resolution iPhone photo on Pro models is
 *  well into double-digit MB). 20 MB matches the prior cap. */
export const MAX_UPLOAD_BYTES_IMAGE = 20 * 1024 * 1024;

/** Documents tend to be smaller than full-res photos but can still go
 *  long (multi-sheet xlsx, multi-megabyte PDF). 25 MB ceilings the
 *  pathological-CSV case without rejecting realistic uploads. */
export const MAX_UPLOAD_BYTES_FILE = 25 * 1024 * 1024;

/**
 * Allowlist of MIME types we accept as `kind: 'file'`. Drives both the
 * server-side classify path and the composer's `accept` attribute via
 * `ATTACHMENT_ACCEPT` (which is the same list with `image/*` prepended).
 *
 * Frozen because callers (tests, future schemas) should never reach in
 * and mutate it — every change should be a code edit reviewed against
 * the upload story.
 */
export const ALLOWED_FILE_TYPES: ReadonlySet<string> = new Set<string>([
	'text/plain',
	'text/csv',
	'text/markdown',
	'application/json',
	'application/pdf',
	'application/zip',
	'application/vnd.ms-excel',
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	'application/msword',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	'application/vnd.ms-powerpoint',
	'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

export interface UploadClassification {
	kind: MediaKind;
	maxBytes: number;
}

/** Returns null when the content type isn't accepted. */
export function classifyUpload(contentType: string): UploadClassification | null {
	if (contentType.startsWith('image/')) {
		return { kind: 'image', maxBytes: MAX_UPLOAD_BYTES_IMAGE };
	}
	if (contentType.startsWith('video/')) {
		return { kind: 'video', maxBytes: MAX_UPLOAD_BYTES_IMAGE };
	}
	if (ALLOWED_FILE_TYPES.has(contentType)) {
		return { kind: 'file', maxBytes: MAX_UPLOAD_BYTES_FILE };
	}
	return null;
}
