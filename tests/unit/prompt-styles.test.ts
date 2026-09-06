import { describe, expect, it } from 'vitest';
import {
	CLARIFY_ONLY_INSTRUCTION,
	detectPromptShape,
	ENHANCER_BASE,
	inputAlreadyMatchesStyle,
	isPromptStyle,
	normalizeStyle,
	preserveInstruction,
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

describe('ENHANCER_BASE fidelity rules', () => {
	it('forbids dropping a user-written detail, and covers negations', () => {
		const base = ENHANCER_BASE.toLowerCase();
		expect(base).toContain('preserve every detail');
		expect(base).toContain('dropping it is not');
		expect(base).toContain('without x');
	});

	it('defers to a style that fixes a required vocabulary or schema', () => {
		// The one place "keep the user's own wording" would otherwise fight a
		// style template (JSON keys, or video's fixed motion verbs).
		expect(ENHANCER_BASE.toLowerCase()).toContain('required vocabulary or schema');
	});
});

describe('detectPromptShape', () => {
	it('detects a booru tag list', () => {
		expect(detectPromptShape('1girl, solo, long hair, holding sword, forest, sunbeam')).toBe(
			'comma-list',
		);
		expect(detectPromptShape('1girl, solo, long_hair, school_uniform, cherry_blossoms')).toBe(
			'comma-list',
		);
	});

	it('detects SDXL-style keyword soup (longer phrases, still not clauses)', () => {
		expect(
			detectPromptShape(
				'young woman in a red jacket, standing on a rooftop at dusk, neon signs behind her, shot on 35mm film, shallow depth of field',
			),
		).toBe('comma-list');
	});

	it('resolves an ambiguous long comma phrase toward prose, not a tag list', () => {
		// Arguably keyword soup, but the first phrase is clause-length. The bias is
		// deliberate: mistaking soup for prose only preserves it for a prose model
		// (harmless); mistaking prose for tags would starve a booru model of tags.
		expect(
			detectPromptShape(
				'a photorealistic portrait of an elderly woman with deep laugh lines, soft window light from the left, shot on an 85mm lens at f/1.4, muted earth tones',
			),
		).toBe('prose');
	});

	it('detects prose, with or without commas', () => {
		expect(
			detectPromptShape('A weathered fisherman mends his nets on a stone pier at first light.'),
		).toBe('prose');
		expect(
			detectPromptShape(
				'A young woman stands on a rooftop at dusk, neon signs glowing behind her, the city humming below.',
			),
		).toBe('prose');
	});

	it('detects a hybrid: short tags first, then prose', () => {
		expect(
			detectPromptShape(
				'1girl, blue hair, detailed armor, she stands at the edge of a ruined cathedral as light filters through broken glass',
			),
		).toBe('tagged-prose');
		// The tags/prose boundary is often a period rather than a comma.
		expect(
			detectPromptShape(
				'1girl, blue hair, detailed armor. She stands at the edge of a ruined cathedral as light filters through broken glass.',
			),
		).toBe('tagged-prose');
	});

	it('detects a JSON object prompt', () => {
		expect(detectPromptShape('{"high_level_description": "a cat on a mat"}')).toBe('json');
	});

	it('applies the prose word floor to comma-separated prompts too', () => {
		// A comma is not evidence of substance: these are seeds, and gating only
		// the comma-less form would hand preserve mode to a thin prompt purely
		// because the user reached for a comma.
		expect(detectPromptShape('dog, has spots')).toBeNull();
		expect(detectPromptShape('a knight, he is tired')).toBeNull();
		expect(detectPromptShape('a girl with a sword, she is angry')).toBeNull();
		// Same floor on the hybrid shape.
		expect(detectPromptShape('1girl, solo, she is sad')).toBeNull();
		expect(detectPromptShape('dog, cat, has spots')).toBeNull();
		// ...but a tag list is complete at three words and must NOT be floored.
		expect(detectPromptShape('1girl, solo, forest')).toBe('comma-list');
	});

	it('does not read a numbered list or an initial as a sentence break', () => {
		// The period in "1." / "J." is not a sentence end; reading it as one made
		// a numbered tag list classify as prose.
		expect(detectPromptShape('1. dog\n2. cat\n3. bird')).toBe('comma-list');
		expect(detectPromptShape('Mr. Smith, a detective')).toBeNull();
	});

	it('returns null for short or ambiguous prompts — the ones enhancement helps most', () => {
		expect(detectPromptShape('a girl with a sword')).toBeNull();
		expect(detectPromptShape('a girl standing in a forest at sunset')).toBeNull();
		expect(detectPromptShape('cat, dog')).toBeNull(); // too few segments to call
		expect(detectPromptShape('')).toBeNull();
		expect(detectPromptShape('   ')).toBeNull();
		expect(detectPromptShape(undefined)).toBeNull();
		expect(detectPromptShape(42)).toBeNull();
		// Looks like JSON, isn't.
		expect(detectPromptShape('{not json at all}')).toBeNull();
	});
});

describe('inputAlreadyMatchesStyle', () => {
	const tags = '1girl, solo, long hair, holding sword, forest, sunbeam';
	const prose = 'A weathered fisherman mends his nets on a stone pier at first light.';
	const hybrid =
		'1girl, blue hair, detailed armor, she stands at the edge of a ruined cathedral as light filters through broken glass';

	it('matches a comma list against BOTH tag styles', () => {
		// Deliberate: booru-vs-phrases isn't reliably detectable, and the formatting
		// delta doesn't justify risking a dropped term in a full rewrite.
		expect(inputAlreadyMatchesStyle(tags, 'booru-tags')).toBe(true);
		expect(inputAlreadyMatchesStyle(tags, 'keyword-soup')).toBe(true);
	});

	it('matches prose against natural-language', () => {
		expect(inputAlreadyMatchesStyle(prose, 'natural-language')).toBe(true);
	});

	it('does not match across regimes — those still need the rewrite', () => {
		expect(inputAlreadyMatchesStyle(tags, 'natural-language')).toBe(false);
		expect(inputAlreadyMatchesStyle(prose, 'booru-tags')).toBe(false);
		expect(inputAlreadyMatchesStyle(prose, 'json')).toBe(false);
		// A bare tag list is missing the hybrid's prose half.
		expect(inputAlreadyMatchesStyle(tags, 'hybrid')).toBe(false);
		// ...and a hybrid's tags still need converting for a prose model.
		expect(inputAlreadyMatchesStyle(hybrid, 'natural-language')).toBe(false);
		expect(inputAlreadyMatchesStyle(hybrid, 'hybrid')).toBe(true);
	});

	it('never matches a json model — shape is not schema', () => {
		// The shape is detected (see detectPromptShape), but a JSON prompt with the
		// wrong keys is shaped right and still wrong, and normalizing onto the
		// model's schema is the whole job. So json takes the rewrite path always.
		const json = '{"high_level_description": "a cat on a mat"}';
		expect(detectPromptShape(json)).toBe('json');
		expect(inputAlreadyMatchesStyle(json, 'json')).toBe(false);
	});

	it('never matches an undetectable prompt', () => {
		for (const s of PROMPT_STYLES) {
			expect(inputAlreadyMatchesStyle('a girl with a sword', s)).toBe(false);
		}
	});
});

describe('preserveInstruction', () => {
	it('names the style and forbids restyling while still allowing additions', () => {
		const t = preserveInstruction('booru-tags');
		expect(t).toContain('BOORU-TAGS');
		expect(t.toLowerCase()).toContain('do not restyle');
		expect(t.toLowerCase()).toContain('may append detail');
		expect(t.toLowerCase()).toContain('must still be present');
	});

	it("overrides the base prompt's reformat rule explicitly", () => {
		// ENHANCER_BASE is composed first and states "mostly REFORMAT it into the
		// target style" as a rule; without an explicit override a weak model
		// resolves the contradiction by reformatting.
		expect(preserveInstruction('booru-tags')).toContain('OVERRIDES');
		expect(ENHANCER_BASE).toContain('mostly REFORMAT it into the target style');
	});
});
