import { describe, expect, it } from 'vitest';
import {
	isVideoPromptStyle,
	normalizeVideoStyle,
	VIDEO_CLARIFY_ONLY_INSTRUCTION,
	VIDEO_ENHANCER_BASE,
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
		expect(normalizeVideoStyle('minimax')).toBe('multimodal-script');
		expect(normalizeVideoStyle('h3')).toBe('multimodal-script');
		expect(normalizeVideoStyle('t2va')).toBe('multimodal-script');
		expect(normalizeVideoStyle('shot-script')).toBe('multimodal-script');
	});

	it('keeps shot-list on structured-cinematic, not the H3 script bucket', () => {
		// `shot-list` predates multimodal-script and means "Wan-style prose in shot
		// order", NOT MiniMax's literally-labeled field format. Reassigning it would
		// silently change the output format for any operator already using it.
		expect(normalizeVideoStyle('shot-list')).toBe('structured-cinematic');
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

	it('multimodal-script demands the three literal field labels', () => {
		const t = VIDEO_STYLE_INSTRUCTIONS['multimodal-script'];
		expect(t).toContain('integrated_multimodal_description:');
		expect(t).toContain('overall_soundscape:');
		expect(t).toContain('non_diegetic_music:');
		expect(t).toContain('[Shot 1]');
	});

	// The two clauses most likely to be trimmed as redundant by a later edit, and
	// the two that carry the no-dialogue case. Without the first, a small enhancer
	// invents speech for silent prompts; without the second, it fabricates a score
	// for every clip (H3's own no-dialogue example uses `non_diegetic_music: N/A`,
	// while an N/A soundscape is explicitly a don't).
	it('multimodal-script guards against invented dialogue', () => {
		const t = VIDEO_STYLE_INSTRUCTIONS['multimodal-script'].toLowerCase();
		expect(t).toContain('do not invent dialogue');
		expect(t).toContain('only if the user');
	});

	// The language tag selects the spoken track's language, so hardcoding
	// [English] mislabels any non-English prompt while the same sentence tells the
	// enhancer to preserve the user's words verbatim.
	it('multimodal-script keeps the dialogue language tag variable', () => {
		const t = VIDEO_STYLE_INSTRUCTIONS['multimodal-script'];
		expect(t).toContain('<d>[Language] …</d>');
		expect(t.toLowerCase()).toContain('never relabel it into a language the user did not write');
	});

	// The enhancer is never told the clip duration (EnhancePromptInput carries no
	// such field), so an unbounded example timestamp is one a short clip can fall
	// short of. The cap is what keeps the opt-in cut path in range.
	it('multimodal-script bounds the opt-in cut timestamp', () => {
		const t = VIDEO_STYLE_INSTRUCTIONS['multimodal-script'];
		expect(t).toContain('00:03.000');
		expect(t).toContain('NOT told the clip');
	});

	it('multimodal-script splits the N/A rule between the two audio fields', () => {
		const t = VIDEO_STYLE_INSTRUCTIONS['multimodal-script'];
		// Soundscape: never N/A (barring explicit silence). Music: N/A is valid.
		expect(t).toMatch(/do NOT write "N\/A" here unless the user explicitly asked for silence/);
		expect(t).toMatch(/no score, write exactly "N\/A"/);
	});

	// multimodal-script's labels are the format, so the shared base must not ban
	// labels outright — a flat ban would contradict the style instruction.
	it('the base prompt permits style-required labels', () => {
		expect(VIDEO_ENHANCER_BASE).toContain('no labels beyond any the target style');
	});

	it('clarify-only template preserves the format and adds motion when missing', () => {
		const t = VIDEO_CLARIFY_ONLY_INSTRUCTION.toLowerCase();
		expect(t).toContain('keep');
		expect(t).toContain('motion');
	});
});
