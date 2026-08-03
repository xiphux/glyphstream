import { describe, expect, it } from 'vitest';
import {
	attachmentDisposition,
	isNeverInlineType,
	normalizeContentType,
	SVG_CONTENT_TYPE,
} from '$lib/server/media/content-type';
import { classifyUpload } from '$lib/server/uploads/classify';

describe('normalizeContentType', () => {
	it('strips parameters, trims, and lowercases', () => {
		expect(normalizeContentType('image/svg+xml; charset=utf-8')).toBe(SVG_CONTENT_TYPE);
		expect(normalizeContentType('IMAGE/PNG')).toBe('image/png');
		expect(normalizeContentType('  text/plain  ')).toBe('text/plain');
		expect(normalizeContentType('video/mp4; codecs="avc1.42E01E"')).toBe('video/mp4');
	});

	it('leaves an already-normalized type untouched', () => {
		expect(normalizeContentType('application/pdf')).toBe('application/pdf');
	});

	it('returns empty string for empty input rather than throwing', () => {
		// Callers pick their own fallback (`application/octet-stream`), so the
		// normalizer stays total and opinion-free.
		expect(normalizeContentType('')).toBe('');
	});
});

describe('isNeverInlineType', () => {
	it('flags every scriptable document type, parameters and casing included', () => {
		for (const raw of [
			'image/svg+xml',
			'image/svg+xml; charset=utf-8',
			'IMAGE/SVG+XML',
			'text/html',
			'text/html;charset=utf-8',
			'application/xhtml+xml',
			'text/xml',
			'application/xml',
		]) {
			expect(isNeverInlineType(raw), raw).toBe(true);
		}
	});

	it('does not flag ordinary media', () => {
		for (const raw of ['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'application/pdf']) {
			expect(isNeverInlineType(raw), raw).toBe(false);
		}
	});
});

describe('attachmentDisposition', () => {
	it('emits both an ASCII fallback and a UTF-8 filename*', () => {
		expect(attachmentDisposition('report.pdf')).toBe(
			`attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
		);
	});

	it('neutralizes quotes and backslashes that would break out of the header', () => {
		const out = attachmentDisposition('a"b\\c.svg');
		expect(out).toContain('filename="a_b_c.svg"');
	});

	it('percent-encodes the RFC 5987 chars encodeURIComponent leaves behind', () => {
		const out = attachmentDisposition("it's (a) *file*.txt");
		expect(out).toMatch(/filename\*=UTF-8''/);
		expect(out.split("filename*=UTF-8''")[1]).not.toMatch(/['()*]/);
	});
});

describe('SVG upload bypass (regression)', () => {
	// The bug: `File.type` preserves MIME parameters verbatim, so a multipart
	// part declaring `image/svg+xml; charset=utf-8` produced exactly that
	// string. The SVG refusal compared with `===` against the bare essence and
	// missed it, while `startsWith('image/')` still matched — so the SVG was
	// stored as `kind: 'image'` and later served inline from our own origin
	// with a live session cookie. This test pins the parsing behavior that
	// made it possible, so a future refactor can't quietly reintroduce it.
	async function typeOfUploadedPart(declaredType: string): Promise<string> {
		const boundary = '----glyphstreamtest';
		const body =
			`--${boundary}\r\n` +
			`Content-Disposition: form-data; name="file"; filename="x.svg"\r\n` +
			`Content-Type: ${declaredType}\r\n\r\n` +
			`<svg xmlns="http://www.w3.org/2000/svg"></svg>\r\n` +
			`--${boundary}--\r\n`;
		const req = new Request('http://localhost/api/uploads', {
			method: 'POST',
			headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
			body,
		});
		const file = (await req.formData()).get('file') as File;
		return file.type;
	}

	it('preserves the MIME parameter on File.type', async () => {
		expect(await typeOfUploadedPart('image/svg+xml; charset=utf-8')).toBe(
			'image/svg+xml; charset=utf-8',
		);
	});

	it('refuses the parameterized SVG that a raw === compare let through', async () => {
		const declared = await typeOfUploadedPart('image/svg+xml; charset=utf-8');
		expect(declared).not.toBe(SVG_CONTENT_TYPE); // the old check compared this
		expect(declared.startsWith('image/')).toBe(true); // ...and this is why it slipped
		expect(classifyUpload(declared)).toBeNull(); // ...and this is the fix
	});
});
