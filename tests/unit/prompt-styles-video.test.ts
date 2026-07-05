import { describe, expect, it } from 'vitest';
import {
	isVideoPromptStyle,
	normalizeVideoStyle,
	VIDEO_CLARIFY_ONLY_INSTRUCTION,
	VIDEO_PROMPT_STYLES,
	VIDEO_STYLE_INSTRUCTIONS,
} from '$lib/server/streaming/prompt-styles-video';
import { normalizeStyle } from '$lib/server/streaming/prompt-styles';

describe('normalizeVideoStyle', () => {
	it('passes through the canonical keys', () => {
		for (const s of VIDEO_PROMPT_STYLES) {
			expect(normalizeVideoStyle(s)).toBe(s);
		}
	});

	it('maps loose aliases onto canonical keys', () => {
		expect(normalizeVideoStyle('cinematic')).toBe('cinematic-prose');
		expect(normalizeVideoStyle('prose')).toBe('cinematic-prose');
		expect(normalizeVideoStyle('ltx')).toBe('cinematic-prose');
		expect(normalizeVideoStyle('sulphur')).toBe('cinematic-prose');
		expect(normalizeVideoStyle('structured')).toBe('structured-cinematic');
		expect(normalizeVideoStyle('formula')).toBe('structured-cinematic');
		expect(normalizeVideoStyle('wan')).toBe('structured-cinematic');
	});

	it('is tolerant of case and separator noise', () => {
		expect(normalizeVideoStyle('Cinematic Prose')).toBe('cinematic-prose');
		expect(normalizeVideoStyle('structured_cinematic')).toBe('structured-cinematic');
		expect(normalizeVideoStyle('  Structured-Cinematic  ')).toBe('structured-cinematic');
	});

	it('returns null for unknown / non-string input', () => {
		expect(normalizeVideoStyle('booru-tags')).toBeNull(); // an image style
		expect(normalizeVideoStyle('')).toBeNull();
		expect(normalizeVideoStyle(undefined)).toBeNull();
		expect(normalizeVideoStyle(null)).toBeNull();
		expect(normalizeVideoStyle(42)).toBeNull();
	});
});

describe('image vs video style sets are disjoint', () => {
	// The kind-aware resolution in models.ts depends on a style from the wrong
	// medium normalizing to null — so no key may be valid in both sets.
	it('no video style normalizes as an image style, and vice versa', () => {
		for (const s of VIDEO_PROMPT_STYLES) {
			expect(normalizeStyle(s)).toBeNull();
		}
	});

	// Some LOOSE aliases ARE valid in both mediums but map to different canonical
	// keys. This collision is exactly why config stores per-model styles raw and
	// normalizes per-kind (see config.ts normalizeAnyStyle / model_prompt_styles):
	// canonicalizing image-first at load would silently downgrade a video model.
	// Documented here so a change to either alias map that alters a collision is
	// caught. `normalizeStyle` wins image-first in normalizeAnyStyle.
	it('cross-medium aliases resolve to DIFFERENT keys per medium', () => {
		const collisions: Array<[string, string, string]> = [
			// alias, image key, video key
			['structured', 'json', 'structured-cinematic'],
			['narrative', 'natural-language', 'cinematic-prose'],
			['prose', 'natural-language', 'cinematic-prose'],
		];
		for (const [alias, imageKey, videoKey] of collisions) {
			expect(normalizeStyle(alias)).toBe(imageKey);
			expect(normalizeVideoStyle(alias)).toBe(videoKey);
		}
	});
});

describe('isVideoPromptStyle', () => {
	it('accepts canonical keys only (not aliases)', () => {
		expect(isVideoPromptStyle('cinematic-prose')).toBe(true);
		expect(isVideoPromptStyle('cinematic')).toBe(false);
		expect(isVideoPromptStyle('nope')).toBe(false);
	});
});

describe('VIDEO_STYLE_INSTRUCTIONS', () => {
	it('has a non-empty template for every style', () => {
		for (const s of VIDEO_PROMPT_STYLES) {
			expect(VIDEO_STYLE_INSTRUCTIONS[s]).toBeTruthy();
		}
	});

	it('cinematic-prose steers to one camera move and present-tense prose', () => {
		const t = VIDEO_STYLE_INSTRUCTIONS['cinematic-prose'].toLowerCase();
		expect(t).toContain('paragraph');
		expect(t).toContain('camera');
		expect(t).toContain('single'); // one clean camera move
	});

	it('structured-cinematic asks for chronological shot-order description', () => {
		const t = VIDEO_STYLE_INSTRUCTIONS['structured-cinematic'].toLowerCase();
		expect(t).toContain('chronological');
		expect(t).toContain('motion');
	});

	it('clarify-only template preserves the format and adds motion when missing', () => {
		const t = VIDEO_CLARIFY_ONLY_INSTRUCTION.toLowerCase();
		expect(t).toContain('keep');
		expect(t).toContain('motion');
	});
});
