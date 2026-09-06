/**
 * The prompt-style taxonomy + the enhancer instruction templates.
 *
 * The metadata layer (a model's `prompt_style` from config or the bridge) says
 * *which* of these styles a target image model wants; this module says what
 * each style *means* to the enhancer LLM. The styles map to the real
 * prompt-formatting regimes image models use:
 *
 *   - natural-language — flowing descriptive prose (Flux 2 Klein, Krea 2 and
 *     its fine-tunes incl. Lustify v10+, ERNIE, Qwen-Image, Z-Image Turbo).
 *   - booru-tags       — comma-separated Danbooru tags (Illustrious, WAI).
 *   - keyword-soup     — short comma-separated descriptive phrases, SDXL-style
 *     (Lustify v8/v9; ChromaHD if the operator opts it here). Style follows the
 *     BASE model, not the checkpoint name — Lustify v10 rebased from SDXL onto
 *     Krea 2, so it belongs under natural-language above.
 *   - hybrid           — booru tags for the subject, prose for the environment
 *     (Anima; ChromaHD also fits).
 *   - json             — a structured JSON object with a fixed key schema
 *     (Ideogram 4, trained exclusively on JSON captions). The exact schema is
 *     model-specific, so it rides on the per-model hint (see below).
 *
 * Per-model nuance the templates can't carry (Illustrious vs WAI quality
 * prefix, Z-Image brevity, Anima's `@artist`/spaces, the exact JSON field
 * schema) rides on the freeform per-model `prompt_hint`, appended after the
 * style template. See `prompt-enhancer.ts` for the composition.
 *
 * Server-only (it lives under `$lib/server`, and the instruction templates are
 * enhancer internals). The taxonomy itself — `PROMPT_STYLES` / `PromptStyle` /
 * `normalizeStyle` — is pure with no server-only imports, so if a client picker
 * ever needs it, split those into a `$lib/prompt-styles.ts` and re-export them
 * here rather than importing this module from the browser bundle.
 */

export const PROMPT_STYLES = [
	'natural-language',
	'booru-tags',
	'keyword-soup',
	'hybrid',
	'json',
] as const;

export type PromptStyle = (typeof PROMPT_STYLES)[number];

/** Narrow guard — true only for a canonical style key. */
export function isPromptStyle(v: unknown): v is PromptStyle {
	return typeof v === 'string' && (PROMPT_STYLES as readonly string[]).includes(v);
}

/**
 * Map a loose, operator- or upstream-supplied style string onto a canonical
 * key, or null when nothing matches. Tolerant of the aliases people naturally
 * reach for (`natural`, `narrative`, `tags`, `booru`, `danbooru`, `keywords`,
 * …) and of separator/case noise (`Booru Tags`, `keyword_soup`).
 */
export function normalizeStyle(raw: unknown): PromptStyle | null {
	if (typeof raw !== 'string') return null;
	const s = raw
		.trim()
		.toLowerCase()
		.replace(/[\s_]+/g, '-');
	if (!s) return null;
	if (isPromptStyle(s)) return s;
	switch (s) {
		case 'natural':
		case 'narrative':
		case 'prose':
		case 'plain':
		case 'plain-english':
		case 'plain-language':
		case 'language':
		case 'natural-prose':
			return 'natural-language';
		case 'tags':
		case 'tag':
		case 'booru':
		case 'danbooru':
		case 'booru-tag':
		case 'tag-soup':
			return 'booru-tags';
		case 'keyword':
		case 'keywords':
		case 'keyword-soup':
		case 'soup':
		case 'sdxl':
			return 'keyword-soup';
		case 'mixed':
		case 'hybrid-tags':
		case 'tags-and-prose':
			return 'hybrid';
		case 'structured':
		case 'structured-json':
		case 'json-prompt':
		case 'ideogram':
			return 'json';
		default:
			return null;
	}
}

/**
 * Shared preamble in front of every style template. States the job, the
 * "don't over-reach" guardrails, and that the enhancer must output ONLY the
 * prompt. Negative prompts are deliberately out of scope — the OpenAI image
 * API GlyphStream calls has no field for them, and the backend supplies its
 * own per-workflow defaults.
 */
export const ENHANCER_BASE = `You are an image-generation prompt engineer. You are given a user's image prompt and must rewrite it to get the best result from a specific image model.

Rules:
- If the prompt is already vivid and detailed, mostly REFORMAT it into the target style; only add detail when the prompt is genuinely vague.
- Never change the subject, intent, or content of the prompt. Do not invent a different scene. Do not add people, text, or objects the user did not ask for.
- PRESERVE EVERY DETAIL THE USER WROTE. Each concrete term they used — subject, counts, names, colors, clothing, materials, actions, spatial relations, setting, lighting, mood, art style, artist references — must survive into your output, either as their own word or as a direct equivalent in the target format. Translating a term is fine; dropping it is not. If a detail resists the target format, keep the user's own wording for it rather than losing it — unless the target style below fixes a required vocabulary or schema, which wins: map the detail onto the nearest allowed term, never drop it.
- Keep the user's negations and exclusions as they wrote them ("no X", "without X"). Never drop one, and never flip it into its opposite.
- Brevity applies only to what YOU add, never to what the user wrote: do not summarize, merge, or generalize their details to make the prompt shorter or tidier.
- Do NOT write a negative prompt, settings, step counts, or any commentary.
- Output ONLY the final prompt text — no quotes, no labels, no preamble, no explanation.`;

/**
 * Per-style formatting instruction. Composed after {@link ENHANCER_BASE} and
 * before any per-model hint. Wording corrected against per-model prompting
 * research (e.g. no Pony `score_N` tags for booru models — that's a different
 * model family; specific camera/film terms beat generic "8k/masterpiece"
 * superlatives for prose models).
 */
export const STYLE_INSTRUCTIONS: Record<PromptStyle, string> = {
	'natural-language': `Target style: NATURAL-LANGUAGE NARRATIVE.
Write flowing, descriptive natural-language sentences (not a list of tags). Order the description as subject → action → setting → lighting/camera/mood/style. Prefer concrete, specific terms — camera bodies, lenses, film stock, time of day, materials, art medium — over generic quality buzzwords. Do NOT use comma-separated tag soup. Do NOT use weight syntax like (word:1.2). Put the most important elements first.`,

	'booru-tags': `Target style: STRICT BOORU (DANBOORU) TAGS.
Write a comma-separated list of concise Danbooru-style tags, each a single concept (e.g. 1girl, solo, long hair, holding sword, forest, sunbeam). Use booru subject tags (1girl/1boy) rather than "woman"/"man". Order roughly: quality/meta tags → subject → pose/action → clothing → setting → composition. Spaces and underscores are equivalent. Do NOT write full sentences. Do NOT emit Pony-style score tags (score_9, score_8_up, etc.) — they belong to a different model family and are noise here.`,

	'keyword-soup': `Target style: KEYWORD SOUP (SDXL).
Write short, comma-separated descriptive PHRASES — not strict single-word anime tags, and not full sentences. Order them subject → action → setting → lighting/camera/mood/style: lead with the user's subject and carry its specific details across, and let the cinematic/photographic terms trail at the end. Those style terms modify the subject; they are never the prompt on their own. Favor concrete camera, film-stock, and lighting vocabulary over generic quality buzzwords. Keep it punchy; avoid long, padded, run-on descriptions.`,

	hybrid: `Target style: HYBRID (TAGS + NATURAL LANGUAGE).
Lead with comma-separated booru-style tags for the subject/character (e.g. 1girl, blue hair, detailed armor), then switch into one or more natural-language sentences describing the environment and atmosphere. Tags carry the character; prose carries the scene.`,

	json: `Target style: STRUCTURED JSON.
Output a single valid JSON object describing the image — and NOTHING else: no prose around it, no markdown code fences, no commentary. Follow the exact field schema given in the model-specific guidance below when one is provided, keeping its keys and structure precisely and putting the descriptive detail in the values. If no schema is given, default to: "high_level_description" (a one-to-two-sentence summary of the whole image), "style_description" (an object: medium, lighting, mood, and a color_palette array of hex colors), and "compositional_deconstruction" (an object with a "background" string and an "elements" array, each element carrying a type, a description, and an optional bounding box).`,
};

/**
 * Used when no style is resolved for the target model (no config override and
 * no upstream metadata). Per the product decision: still help vague prompts,
 * but DO NOT restyle — preserve whatever format the user wrote.
 */
export const CLARIFY_ONLY_INSTRUCTION = `Target style: PRESERVE THE USER'S FORMAT.
You do not know this model's preferred prompt format, so KEEP the format the user already used (if they wrote tags, keep tags; if they wrote prose, keep prose). Only clarify or lightly expand the prompt when it is genuinely vague or underspecified; if it is already detailed, return it essentially unchanged. Do not convert between tags and prose.`;

/**
 * The coarse *shapes* a user-written prompt can be recognized as. Deliberately
 * coarser than {@link PromptStyle}: the taxonomy above describes what a MODEL
 * wants, this describes what can be told about a prompt from the text alone,
 * and those aren't the same resolution. `booru-tags` vs `keyword-soup` in
 * particular is not honestly detectable — `1girl` and `underscore_tags` are
 * strong signals, but "detailed armor" vs "cinematic lighting" is not — so both
 * collapse into `comma-list` (see {@link STYLE_ACCEPTS_SHAPE} for why that's
 * the right call rather than a limitation to work around).
 */
export const PROMPT_SHAPES = ['json', 'comma-list', 'tagged-prose', 'prose'] as const;

export type PromptShape = (typeof PROMPT_SHAPES)[number];

/**
 * Which input shapes count as "already in this style", i.e. a rewrite would be
 * pure risk. A comma-separated list satisfies BOTH tag styles on purpose: the
 * booru-vs-phrases difference is a mild formatting nudge, and paying for it
 * with a full LLM rewrite of an already-correctly-shaped prompt trades a small
 * formatting gain for the real risk of a dropped or paraphrased term.
 *
 * Note what does NOT match: a bare comma-list against `hybrid` (it's missing
 * the prose half), or `tagged-prose` against `natural-language` (the tags do
 * need converting). Those still take the normal rewrite path.
 */
export const STYLE_ACCEPTS_SHAPE: Record<PromptStyle, readonly PromptShape[]> = {
	'natural-language': ['prose'],
	'booru-tags': ['comma-list'],
	'keyword-soup': ['comma-list'],
	hybrid: ['tagged-prose'],
	json: ['json'],
};

/** A segment this long reads as a clause, not a tag or keyword phrase. */
const CLAUSE_WORDS = 9;
/** Max words in a segment for a list to still read as tags/keyword phrases. */
const MAX_LIST_SEGMENT_WORDS = 8;
/** Max words in a leading tag segment of a hybrid (tags → prose) prompt. */
const MAX_TAG_WORDS = 4;
/** A comma-less prompt needs at least this many words to read as written-out
 *  prose rather than a vague seed phrase (which is exactly what enhancement
 *  exists to expand, so those must NOT be detected). Set well above a
 *  one-clause seed like "a girl standing in a forest at sunset" (8 words) —
 *  that's thin, and a prose model genuinely benefits from expanding it. */
const MIN_PROSE_WORDS = 12;

/** Copulas/auxiliaries — the cheapest reliable "this is a sentence, not a tag"
 *  signal. Deliberately excludes -ing forms: "standing on a rooftop" is a
 *  keyword phrase, "she is standing" is prose. */
const CLAUSE_MARKER =
	/\b(?:is|are|was|were|be|been|being|has|have|had|will|would|can|could|should)\b/i;
/** Sentence-terminal punctuation followed by more text — a real sentence break,
 *  as opposed to a single trailing period on a tag list. */
const INTERNAL_SENTENCE_BREAK = /[.!?]["'’)\]]?\s+\S/;

const wordCount = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);

/** True when a segment reads as a clause rather than a tag/keyword phrase. */
function isClauseLike(segment: string): boolean {
	return (
		wordCount(segment) >= CLAUSE_WORDS ||
		CLAUSE_MARKER.test(segment) ||
		INTERNAL_SENTENCE_BREAK.test(segment)
	);
}

/**
 * Classify what shape the USER wrote their prompt in, or null when the text
 * doesn't say clearly. Pure and deterministic.
 *
 * Biased hard toward null: a miss costs nothing (the prompt takes the normal
 * rewrite path it takes today), while a false positive suppresses a rewrite the
 * target model actually needed. So short or ambiguous prompts return null by
 * design — those are the vague ones enhancement is most useful for anyway.
 *
 * Where it must guess, it guesses `prose`, because the two misreadings are not
 * symmetric. Calling a long keyword phrase prose only ever preserves a
 * comma-phrase prompt for a prose model, which reads it fine; calling prose a
 * tag list would preserve sentences for a booru model, which genuinely needs
 * the tags. So a comma segment long enough to be a clause (see
 * {@link CLAUSE_WORDS}) counts as one even without a verb in it.
 */
export function detectPromptShape(raw: unknown): PromptShape | null {
	if (typeof raw !== 'string') return null;
	const s = raw.trim();
	if (!s) return null;

	if (s.startsWith('{') && s.endsWith('}')) {
		try {
			const parsed: unknown = JSON.parse(s);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return 'json';
		} catch {
			// Not JSON after all — fall through to the text heuristics.
		}
	}

	const segments = s
		.split(/[,\n]+/)
		.map((x) => x.trim())
		.filter(Boolean);

	// No commas at all: prose if it's long enough to be written-out description,
	// otherwise too small to call.
	if (segments.length === 1) return wordCount(s) >= MIN_PROSE_WORDS ? 'prose' : null;

	// Hybrid: a run of short tags, then the prose takes over and never goes back.
	const firstClause = segments.findIndex(isClauseLike);
	if (
		firstClause >= 2 &&
		segments.slice(0, firstClause).every((seg) => wordCount(seg) <= MAX_TAG_WORDS)
	) {
		return 'tagged-prose';
	}

	// Tag / keyword list: several segments, none of which is a clause.
	if (
		firstClause === -1 &&
		segments.length >= 3 &&
		segments.every((seg) => wordCount(seg) <= MAX_LIST_SEGMENT_WORDS)
	) {
		return 'comma-list';
	}

	// Prose that happens to contain commas.
	if (firstClause !== -1) return 'prose';

	return null;
}

/**
 * True when the user's prompt is already written in the target model's
 * preferred format, so the enhancer should preserve rather than restyle it.
 */
export function inputAlreadyMatchesStyle(prompt: string, style: PromptStyle): boolean {
	const shape = detectPromptShape(prompt);
	return shape !== null && STYLE_ACCEPTS_SHAPE[style].includes(shape);
}

/**
 * Used INSTEAD of the style template when the user's prompt already matches the
 * target style: the reformat half of the job is already done, and asking a
 * small utility model to "rewrite this into <style>" anyway is how a term gets
 * paraphrased or quietly dropped. Additions are still allowed — the prompt may
 * be correctly shaped and still thin — but the user's own words are floor, not
 * raw material.
 *
 * Takes the style label as a plain string so it stays medium-agnostic; only the
 * image side detects today (see `prompt-enhancer.ts` for why).
 */
export function preserveInstruction(styleLabel: string): string {
	return `Target style: ${styleLabel.toUpperCase()} — ALREADY MATCHED. Do NOT restyle.
The user's prompt is already written in this model's preferred format, so a rewrite can only lose fidelity. Keep their wording, their terms, and their ordering. Do not paraphrase, re-order, re-tag, convert between tags and prose, or otherwise "tidy up" what they wrote.
You MAY append detail in the same format when something is genuinely missing, and you may fix separators or punctuation. Every word the user wrote must still be present in your output. Adding nothing is a perfectly good answer: if the prompt needs no addition, return it exactly as given.`;
}
