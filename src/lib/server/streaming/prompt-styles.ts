/**
 * The prompt-style taxonomy + the enhancer instruction templates.
 *
 * The metadata layer (a model's `prompt_style` from config or the bridge) says
 * *which* of these styles a target image model wants; this module says what
 * each style *means* to the enhancer LLM. The styles map to the real
 * prompt-formatting regimes image models use:
 *
 *   - natural-language — flowing descriptive prose (Flux 2 Klein, Krea 2,
 *     ERNIE, Qwen-Image, Z-Image Turbo).
 *   - booru-tags       — comma-separated Danbooru tags (Illustrious, WAI).
 *   - keyword-soup     — short comma-separated descriptive phrases, SDXL-style
 *     (Lustify; ChromaHD if the operator opts it here).
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
Write short, comma-separated descriptive PHRASES — not strict single-word anime tags, and not full sentences. Favor cinematic and photography vocabulary (e.g. analog film photo, 35mm, dramatic lighting, shallow depth of field, gritty texture). Concrete camera and film-stock terms work well. Keep it punchy; avoid long, padded, run-on descriptions.`,

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
