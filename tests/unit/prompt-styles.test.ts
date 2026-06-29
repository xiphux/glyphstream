import { describe, expect, it } from 'vitest';
import {
	CLARIFY_ONLY_INSTRUCTION,
	isPromptStyle,
	normalizeStyle,
	PROMPT_STYLES,
	STYLE_INSTRUCTIONS,
} from '$lib/server/streaming/prompt-styles';

describe('normalizeStyle', () => {
	it('passes through the canonical keys', () => {
		for (const s of PROMPT_STYLES) {
			expect(normalizeStyle(s)).toBe(s);
		}
	});

	it('maps loose aliases onto canonical keys', () => {
		expect(normalizeStyle('natural')).toBe('natural-language');
		expect(normalizeStyle('narrative')).toBe('natural-language');
		expect(normalizeStyle('prose')).toBe('natural-language');
		expect(normalizeStyle('tags')).toBe('booru-tags');
		expect(normalizeStyle('booru')).toBe('booru-tags');
		expect(normalizeStyle('danbooru')).toBe('booru-tags');
		expect(normalizeStyle('keywords')).toBe('keyword-soup');
		expect(normalizeStyle('soup')).toBe('keyword-soup');
		expect(normalizeStyle('mixed')).toBe('hybrid');
		expect(normalizeStyle('json')).toBe('json');
		expect(normalizeStyle('structured')).toBe('json');
		expect(normalizeStyle('structured-json')).toBe('json');
		expect(normalizeStyle('ideogram')).toBe('json');
	});

	it('is tolerant of case and separator noise', () => {
		expect(normalizeStyle('Booru Tags')).toBe('booru-tags');
		expect(normalizeStyle('keyword_soup')).toBe('keyword-soup');
		expect(normalizeStyle('  Natural-Language  ')).toBe('natural-language');
	});

	it('returns null for unknown / non-string input', () => {
		expect(normalizeStyle('photoreal')).toBeNull();
		expect(normalizeStyle('')).toBeNull();
		expect(normalizeStyle(undefined)).toBeNull();
		expect(normalizeStyle(null)).toBeNull();
		expect(normalizeStyle(42)).toBeNull();
	});
});

describe('isPromptStyle', () => {
	it('accepts canonical keys only (not aliases)', () => {
		expect(isPromptStyle('booru-tags')).toBe(true);
		expect(isPromptStyle('danbooru')).toBe(false);
		expect(isPromptStyle('nope')).toBe(false);
	});
});

describe('STYLE_INSTRUCTIONS', () => {
	it('has a non-empty template for every style', () => {
		for (const s of PROMPT_STYLES) {
			expect(STYLE_INSTRUCTIONS[s]).toBeTruthy();
		}
	});

	it('warns booru-tags away from Pony score_N tags', () => {
		// The single most common cross-contamination bug — assert the guardrail
		// is actually present in the template.
		expect(STYLE_INSTRUCTIONS['booru-tags'].toLowerCase()).toContain('score');
	});

	it('clarify-only template tells the model to preserve the format', () => {
		expect(CLARIFY_ONLY_INSTRUCTION.toLowerCase()).toContain('keep');
	});

	it('json template asks for a JSON object and defers the schema to the hint', () => {
		const t = STYLE_INSTRUCTIONS['json'].toLowerCase();
		expect(t).toContain('json');
		expect(t).toContain('schema'); // points at the per-model hint for exact fields
	});
});
