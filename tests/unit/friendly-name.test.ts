import { describe, expect, it } from 'vitest';
import { friendlyModelName } from '$lib/server/endpoints/friendly-name';

describe('friendlyModelName', () => {
	it('strips the endpoint:: prefix', () => {
		expect(friendlyModelName('bridge::gpt-4o')).toBe('gpt-4o');
	});

	it('strips both endpoint:: and owner/ prefixes', () => {
		expect(friendlyModelName('bridge::comfyui/ltx-2-3-t2v')).toBe('ltx-2-3-t2v');
	});

	it('uses only the last slash segment when multiple owner segments exist', () => {
		// HuggingFace-style: org/model is common, but org/group/model also occurs.
		expect(friendlyModelName('endpoint::meta-llama/Llama-3-70B')).toBe('Llama-3-70B');
		expect(friendlyModelName('endpoint::a/b/c-model')).toBe('c-model');
	});

	it('returns the input unchanged when there is no endpoint or owner prefix', () => {
		expect(friendlyModelName('plain-model')).toBe('plain-model');
	});

	it('handles owner prefix without endpoint prefix', () => {
		// Defensive: callers sometimes pass already-stripped ids.
		expect(friendlyModelName('comfyui/anima')).toBe('anima');
	});

	it('returns empty string when the slash is the trailing character', () => {
		// Edge case — wouldn't naturally occur, but the function shouldn't crash.
		expect(friendlyModelName('bridge::owner/')).toBe('');
	});
});
