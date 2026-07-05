/**
 * The VIDEO prompt-style taxonomy + enhancer instruction templates — the video
 * sibling of `prompt-styles.ts` (which covers image models). Kept a separate
 * track on purpose: video prompting adds a temporal axis image styles don't
 * model — camera *movement* (dolly/pan/track/orbit) with speed/amplitude,
 * present-tense action over time, and length that scales with clip duration —
 * so reusing the image styles (booru tags, JSON captions, …) or the image
 * enhancer base ("image-generation prompt engineer") would misfire.
 *
 * Two style buckets, from the real regimes today's text-to-video models use:
 *
 *   - cinematic-prose      — one flowing present-tense paragraph, a single
 *     clean camera move, concrete physical detail (Lightricks LTX-2.3 and its
 *     fine-tunes, e.g. Sulphur 2). Rejects templates/shot-lists/tags.
 *   - structured-cinematic — chronological shot-order formula written as prose:
 *     entity → scene → motion(+pacing) → aesthetic(light/lens/shot) →
 *     stylization (Alibaba Wan 2.2). "Begins… then…" progression markers.
 *
 * Per-model nuance the bucket template can't carry rides on the freeform
 * per-model `prompt_hint` (appended after the style instruction by
 * `prompt-enhancer.ts`), exactly as on the image side — e.g. "LTX generates
 * synchronized audio: end with a brief ambient-sound cue", or Sulphur 2's
 * "concrete anatomical description, avoid abstract metaphor".
 *
 * Server-only (instruction templates are enhancer internals). The taxonomy
 * itself is pure; if a client picker ever needs it, split the keys/normalizer
 * into a `$lib` module and re-export here rather than importing this from the
 * browser bundle.
 */

export const VIDEO_PROMPT_STYLES = ['cinematic-prose', 'structured-cinematic'] as const;

export type VideoPromptStyle = (typeof VIDEO_PROMPT_STYLES)[number];

/** Narrow guard — true only for a canonical video style key. */
export function isVideoPromptStyle(v: unknown): v is VideoPromptStyle {
	return typeof v === 'string' && (VIDEO_PROMPT_STYLES as readonly string[]).includes(v);
}

/**
 * Map a loose, operator- or upstream-supplied style string onto a canonical
 * video style key, or null when nothing matches. Tolerant of the aliases people
 * reach for (`cinematic`, `prose`, `ltx`; `structured`, `formula`, `wan`) and
 * of separator/case noise (`Cinematic Prose`, `structured_cinematic`).
 */
export function normalizeVideoStyle(raw: unknown): VideoPromptStyle | null {
	if (typeof raw !== 'string') return null;
	const s = raw
		.trim()
		.toLowerCase()
		.replace(/[\s_]+/g, '-');
	if (!s) return null;
	if (isVideoPromptStyle(s)) return s;
	switch (s) {
		case 'cinematic':
		case 'prose':
		case 'cinematic-prose-paragraph':
		case 'narrative':
		case 'paragraph':
		case 'ltx':
		case 'ltxv':
		case 'sulphur':
			return 'cinematic-prose';
		case 'structured':
		case 'structured-prose':
		case 'formula':
		case 'cinematographic':
		case 'shot-list':
		case 'wan':
		case 'wan2.2':
			return 'structured-cinematic';
		default:
			return null;
	}
}

/**
 * Shared preamble in front of every video style template. States the job, the
 * "don't over-reach" guardrails, present-tense rule, and that the enhancer must
 * output ONLY the prompt. Negative prompts are deliberately out of scope — same
 * as the image side (the OpenAI video API has no field for them; the backend
 * supplies its own per-workflow defaults).
 */
export const VIDEO_ENHANCER_BASE = `You are a text-to-video prompt engineer and cinematographer. You are given a user's video prompt and must rewrite it to get the best result from a specific text-to-video model.

Rules:
- Describe MOTION over time, not a frozen still: what the subject does, and how the camera moves (dolly, pan, track, orbit, crane, push/pull) with its speed. A video prompt without motion is a wasted prompt.
- Write in PRESENT TENSE ("she walks", not "she walked" or "make her walk").
- If the prompt is already vivid and detailed, mostly REFORMAT it into the target style; only add detail when the prompt is genuinely vague.
- Never change the subject, intent, or content of the prompt. Do not invent a different scene. Do not add people, text, or objects the user did not ask for.
- Do NOT write a negative prompt, settings, step counts, resolution tags, or any commentary.
- Output ONLY the final prompt text — no quotes, no labels, no preamble, no explanation.`;

/**
 * Per-style formatting instruction. Composed after {@link VIDEO_ENHANCER_BASE}
 * and before any per-model hint. Wording grounded in per-model prompting
 * research (LTX/Sulphur cinematic prose; Wan's entity→scene→motion→aesthetic
 * formula written as prose).
 */
export const VIDEO_STYLE_INSTRUCTIONS: Record<VideoPromptStyle, string> = {
	'cinematic-prose': `Target style: CINEMATIC NATURAL-LANGUAGE PROSE.
Write ONE flowing paragraph of present-tense description — like a director's note, not a bullet list or a "[camera], [subject]" template. Order it as subject → action → camera movement → lighting/mood. Name a SINGLE clean camera move (e.g. "slow dolly-in", "orbits left") rather than combining two — the model executes one move cleanly and smears when overloaded. Prefer concrete, physical description over abstract metaphor. Scale detail to length: a short clip wants 2–3 sentences, a longer one 5–7. Do NOT use comma-separated tag soup, weight syntax like (word:1.2), or shot-list formatting.`,

	'structured-cinematic': `Target style: STRUCTURED CINEMATOGRAPHIC (written as prose).
Write descriptive sentences in chronological shot order, front-loading what the camera first captures, then how the shot develops. Cover, in order: the subject (with detail) → the scene/environment → the motion, describing its amplitude and speed and using progression markers ("begins by…, then…") → aesthetic control (light source and quality, shot size, camera angle, lens, camera movement) → any named stylization (e.g. cyberpunk, claymation, time-lapse). Aim for roughly 80–120 words of vivid detail. Still prose, not tags — the temporal relationships between clauses carry meaning a tag list can't.`,
};

/**
 * Used when no style is resolved for the target video model (no config override
 * and no upstream metadata). Per the product decision: still help vague
 * prompts, but DO NOT restyle — preserve whatever format the user wrote, only
 * making sure motion/camera intent is present.
 */
export const VIDEO_CLARIFY_ONLY_INSTRUCTION = `Target style: PRESERVE THE USER'S FORMAT.
You do not know this model's preferred prompt format, so KEEP the structure the user already used. Only clarify or lightly expand the prompt when it is genuinely vague — and if it lacks any sense of motion or camera, add a concise, natural motion/camera cue. If it is already detailed, return it essentially unchanged. Do not convert between prose and structured formats.`;
