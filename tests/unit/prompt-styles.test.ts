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

	it('tells booru-tags that a subject tag is a headcount', () => {
		// Measured against the configured 4B enhancer: without this, "three women"
		// produced a correct count tag in 2 of 5 runs.
		const t = STYLE_INSTRUCTIONS['booru-tags'];
		expect(t).toContain('2girls');
		expect(t.toLowerCase()).toContain('headcount');
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

	it('forbids inventing an attribute the user left unstated', () => {
		// Measured failure, not a hypothetical: the configured 4B enhancer returned
		// `1girl` for an ungendered "lone figure" / "knight" in 3 of 3 runs.
		const base = ENHANCER_BASE.toLowerCase();
		expect(base).toContain('left unstated');
		expect(base).toContain('1girl');
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

	it('reads prose typed across several short lines as prose, not a tag list', () => {
		// The newline that carried each sentence break is eaten by segmentation, so
		// the break has to be looked for in the whole string. Getting this wrong
		// hands a booru model three English sentences with the rewrite suppressed.
		expect(
			detectPromptShape(
				'A cyberpunk city street at night.\nNeon signs reflect in puddles.\nA lone figure walks away.',
			),
		).toBe('prose');
		expect(
			detectPromptShape(
				'An old lighthouse stands on a cliff.\nWaves crash below.\nStorm clouds gather overhead.',
			),
		).toBe('prose');
	});

	it('still reads a per-line tag list as a tag list', () => {
		expect(detectPromptShape('1girl\nsolo\nlong hair\nforest\nsunbeam')).toBe('comma-list');
	});

	it('does not mistake a decimal or version number for a sentence break', () => {
		// These ride through the same whole-string check as the multi-line prose
		// above, and a false break there would strip preserve mode off real tag
		// lists.
		expect(detectPromptShape('(masterpiece:1.2), best quality, 1girl, solo, forest')).toBe(
			'comma-list',
		);
		expect(detectPromptShape('85mm f/1.8, bokeh, golden hour, portrait')).toBe('comma-list');
		expect(detectPromptShape('sdxl 1.0, anime style, 1girl, solo')).toBe('comma-list');
	});

	it('does not treat an everyday noun that doubles as an auxiliary as a clause', () => {
		// "can" and "will" are auxiliaries AND common prompt nouns; matching them
		// pushed genuine tag lists toward the prose shapes.
		expect(
			detectPromptShape(
				'1girl, solo, can badge, school uniform, long hair, holding bag, classroom, sunlight',
			),
		).toBe('comma-list');
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

	it('wants positive booru evidence before preserving for a booru model', () => {
		// isClauseLike can't see a lexical finite verb, so comma-joined prose reads
		// as a list. keyword-soup reads that fine; a booru model handed English
		// sentences with the rewrite suppressed is the failure this detector exists
		// to avoid — so booru-tags asks a second question.
		const prose = 'A knight rides through the forest, his cloak trailing behind him, mist rising';
		expect(detectPromptShape(prose)).toBe('comma-list');
		expect(inputAlreadyMatchesStyle(prose, 'booru-tags')).toBe(false);
		expect(inputAlreadyMatchesStyle(prose, 'keyword-soup')).toBe(true);
	});

	it('KNOWN GAP: appositive prose still preserves for a hybrid model', () => {
		// Not an accident and not (yet) worth closing. A comma-set-off appositive
		// reaches the tagged-prose shape with no tag in it, and hybrid is ungated —
		// but measured against a 4B enhancer the restyle this would unlock is worse
		// than the preserve it prevents (an invented `1girl` for an ungendered
		// knight, 3/3), and gating on a booru signal costs most genuine hybrids.
		// Asserted so the gap is visible in CI rather than rediscovered; if you
		// close it, this expectation flips and that is the point.
		const appositive =
			'A knight, weary and cold, rides through the forest as mist rises from the ground';
		expect(detectPromptShape(appositive)).toBe('tagged-prose');
		expect(inputAlreadyMatchesStyle(appositive, 'hybrid')).toBe(true);
	});

	it('preserves a genuine hybrid that carries no booru subject tag', () => {
		// Every other tagged-prose fixture here is 1girl-led, which hid the cost of
		// gating hybrid on a booru signal: this prompt has none and must still
		// preserve.
		expect(
			inputAlreadyMatchesStyle(
				'cyberpunk city, neon signs, rain, a lone figure walks down the rain-slicked street as steam rises',
				'hybrid',
			),
		).toBe(true);
	});

	it('accepts a tag list on any one of the three booru signals', () => {
		// A subject tag...
		expect(
			inputAlreadyMatchesStyle('1girl, standing near a window, afternoon light', 'booru-tags'),
		).toBe(true);
		// ...an underscore tag...
		expect(
			inputAlreadyMatchesStyle('long_hair, standing near a window, afternoon light', 'booru-tags'),
		).toBe(true);
		// ...or segments short enough to be tags rather than clauses.
		expect(
			inputAlreadyMatchesStyle(
				'cyberpunk street at night, rain-slicked asphalt, neon reflections, volumetric fog',
				'booru-tags',
			),
		).toBe(true);
	});

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
