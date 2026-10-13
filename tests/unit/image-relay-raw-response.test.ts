/** The stored upstream response must not carry the image bytes a second time. */
import { describe, expect, it } from 'vitest';
import { rawResponseForStorage } from '#lib/server/streaming/image-relay.js';

describe('rawResponseForStorage', () => {
	it('replaces each b64_json with its length and keeps the rest', () => {
		const b64 = 'A'.repeat(5000);
		const stored = rawResponseForStorage({
			created: 1,
			data: [{ b64_json: b64, revised_prompt: 'a cat' }, { b64_json: b64 }],
			aspect_ratio: '1:1',
		});
		expect(stored).not.toContain(b64);
		expect(stored.length).toBeLessThan(300);
		expect(JSON.parse(stored)).toEqual({
			created: 1,
			data: [
				{ b64_json: '[5000 base64 chars, stored as media]', revised_prompt: 'a cat' },
				{ b64_json: '[5000 base64 chars, stored as media]' },
			],
			aspect_ratio: '1:1',
		});
	});

	it('leaves a url-style response untouched', () => {
		const upstream = { data: [{ url: 'https://x/y.png' }] };
		expect(rawResponseForStorage(upstream)).toBe(JSON.stringify(upstream));
	});
});
