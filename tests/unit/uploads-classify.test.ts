import { describe, expect, it } from 'vitest';
import {
	classifyUpload,
	MAX_UPLOAD_BYTES_FILE,
	MAX_UPLOAD_BYTES_IMAGE,
} from '$lib/server/uploads/classify';

describe('classifyUpload', () => {
	it('returns kind:image for any image/* MIME', () => {
		expect(classifyUpload('image/png')).toEqual({
			kind: 'image',
			maxBytes: MAX_UPLOAD_BYTES_IMAGE,
		});
		expect(classifyUpload('image/jpeg')).toEqual({
			kind: 'image',
			maxBytes: MAX_UPLOAD_BYTES_IMAGE,
		});
		expect(classifyUpload('image/webp')?.kind).toBe('image');
		expect(classifyUpload('image/heic')?.kind).toBe('image');
	});

	it('returns kind:video for any video/* MIME', () => {
		expect(classifyUpload('video/mp4')?.kind).toBe('video');
		expect(classifyUpload('video/quicktime')?.kind).toBe('video');
		expect(classifyUpload('video/webm')?.kind).toBe('video');
	});

	it('accepts the enumerated document MIME types as kind:file', () => {
		// Representatives from each branch of the allowlist — spreadsheet,
		// document, presentation, archive, plain text, structured data.
		const accepted = [
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
		];
		for (const mime of accepted) {
			expect(classifyUpload(mime)).toEqual({
				kind: 'file',
				maxBytes: MAX_UPLOAD_BYTES_FILE,
			});
		}
	});

	it('rejects unknown application/* MIMEs — allowlist, not blocklist', () => {
		// The point of an enumerated allowlist is that a future MIME we
		// haven't reviewed (e.g. installer packages, archives we don't want)
		// fails closed rather than silently slipping through.
		expect(classifyUpload('application/x-apple-diskimage')).toBeNull();
		expect(classifyUpload('application/octet-stream')).toBeNull();
		expect(classifyUpload('application/x-shockwave-flash')).toBeNull();
	});

	it('rejects empty / nonsense content types', () => {
		expect(classifyUpload('')).toBeNull();
		expect(classifyUpload('text')).toBeNull();
		expect(classifyUpload('/')).toBeNull();
	});

	it('uses a smaller cap for file kinds than for image/video kinds', () => {
		// The size caps are deliberately split: photos can be large
		// (full-res iPhone Pro photos clear 10 MB) but a 2 GB CSV is
		// nearly always a misuse / accident. The asymmetry is the
		// guard rail.
		expect(MAX_UPLOAD_BYTES_FILE).toBeLessThan(MAX_UPLOAD_BYTES_IMAGE * 2);
		expect(classifyUpload('image/png')?.maxBytes).toBe(MAX_UPLOAD_BYTES_IMAGE);
		expect(classifyUpload('text/csv')?.maxBytes).toBe(MAX_UPLOAD_BYTES_FILE);
	});
});
