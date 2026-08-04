/**
 * The VIDEO prompt-style taxonomy + enhancer instruction templates — the video
 * sibling of `prompt-styles.ts` (which covers image models). Kept a separate
 * track on purpose: video prompting adds a temporal axis image styles don't
 * model — camera *movement* (dolly/pan/track/orbit) with speed/amplitude,
 * present-tense action over time, and length that scales with clip duration —
 * so reusing the image styles (booru tags, JSON captions, …) or the image
 * enhancer base ("image-generation prompt engineer") would misfire.
 *
 * Three style buckets, from the real regimes today's text-to-video models use:
 *
 *   - cinematic-prose      — one flowing present-tense paragraph, a single
 *     clean camera move, concrete physical detail (Lightricks LTX-2.3 and its
 *     fine-tunes, e.g. Sulphur 2). Rejects templates/shot-lists/tags.
 *   - structured-cinematic — chronological shot-order formula written as prose:
 *     entity → scene → motion(+pacing) → aesthetic(light/lens/shot) →
 *     stylization (Alibaba Wan 2.2). "Begins… then…" progression markers.
 *   - multimodal-script    — three literally-labeled fields (video description,
 *     soundscape, non-diegetic music) with `[Shot N]` markers and a fixed
 *     camera-motion vocabulary (MiniMax H3). The only bucket that models AUDIO
 *     as its own axis, because H3 generates picture and sound together.
 *
 * `multimodal-script` is why {@link VIDEO_ENHANCER_BASE} defers to the style on
 * labels, quotes, and camera vocabulary rather than banning or prescribing them
 * outright: in that bucket the labels ARE the format, on-screen text has to be
 * quoted, and H3 accepts only its own motion verbs (no dolly/crane). A flat base
 * rule would have the base fighting the style instruction — which small utility
 * enhancer models resolve badly. When adding a style, check the base's rules for
 * this same class of conflict rather than assuming they're medium-wide truths.
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

export const VIDEO_PROMPT_STYLES = [
	'cinematic-prose',
	'structured-cinematic',
	'multimodal-script',
] as const;

export type VideoPromptStyle = (typeof VIDEO_PROMPT_STYLES)[number];

/** Narrow guard — true only for a canonical video style key. */
export function isVideoPromptStyle(v: unknown): v is VideoPromptStyle {
	return typeof v === 'string' && (VIDEO_PROMPT_STYLES as readonly string[]).includes(v);
}

/**
 * Map a loose, operator- or upstream-supplied style string onto a canonical
 * video style key, or null when nothing matches. Tolerant of the aliases people
 * reach for (`cinematic`, `prose`, `ltx`; `structured`, `formula`, `wan`;
 * `minimax`, `h3`, `t2va`) and of separator/case noise (`Cinematic Prose`,
 * `structured_cinematic`).
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
		case 'multimodal':
		case 'script':
		case 'shot-script':
		case 'av-script':
		case 'minimax':
		case 'minimax-h3':
		case 'h3':
		case 't2va':
			return 'multimodal-script';
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
- Describe MOTION over time, not a frozen still: what the subject does, and how the camera moves (dolly, pan, track, orbit, crane, push/pull — unless the target style below fixes its own motion vocabulary, which then wins) with its speed. A video prompt without motion is a wasted prompt.
- Write in PRESENT TENSE ("she walks", not "she walked" or "make her walk").
- If the prompt is already vivid and detailed, mostly REFORMAT it into the target style; only add detail when the prompt is genuinely vague.
- Never change the subject, intent, or content of the prompt. Do not invent a different scene. Do not add people, text, or objects the user did not ask for.
- Do NOT write a negative prompt, settings, step counts, resolution tags, or any commentary.
- Output ONLY the final prompt text — no preamble, no explanation, no wrapping quotes around the whole thing, and no labels beyond any the target style below explicitly requires. (Quotation marks WITHIN the prompt are fine when the target style asks for them.)`;

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

	'multimodal-script': `Target style: MULTIMODAL SHOT SCRIPT (three labeled fields).
Output exactly three fields, in this order, each starting on its own line with a blank line between them. The labels are literal and required — write them exactly as shown, including the blank lines:

integrated_multimodal_description: …

overall_soundscape: …

non_diegetic_music: …

integrated_multimodal_description — open with "[Shot 1] " followed by the visual style and composition (e.g. "Live-action, cinematic, a medium-wide shot frames…"), then describe the action chronologically in present tense. NEVER put a timestamp on the first shot. Use a SINGLE shot unless the user's prompt clearly asks for a cut or scene change; only then add a second shot in the form "[Shot 2] At 00:02.400, the camera cuts to…" with a strictly increasing timestamp. You are NOT told the clip's duration, so keep any cut early — under 00:03.000 — rather than guessing a later time that may fall past the end of a short clip. Describe camera motion as motion type + amplitude + speed, woven into the sentence ("The camera pushes in with small amplitude at slow speed toward…"). Use only these motion types: Zoom In/Out, Push In/Pull Out, Pan Left/Right, Truck Left/Right, Tilt Up/Down, Pedestal Up/Down, Arc Shot, Tracking Shot, Static Shot, Shake Slightly/Strongly, POV, Roll Clockwise/Counterclockwise. Amplitude is "with small amplitude" or "with large amplitude"; speed is "at slow speed" or "at fast speed". Put any on-screen text verbatim inside quotation marks.
Only if the user's prompt contains or clearly implies spoken or sung words: give each vocalizing character a stable ID — (S1), (S2) — and wrap their words in <d>[Language] …</d>, preserving the user's wording and punctuation exactly. Replace "Language" with the language the speech is actually written in — <d>[English] …</d> for English, <d>[Spanish] …</d> for Spanish — never relabel it into a language the user did not write. If the prompt has no speech, emit no speaker IDs and no <d> tags, and do not invent dialogue.

overall_soundscape — 1–4 sentences as one continuous paragraph covering ambient sound, physical action sounds, and non-verbal human sounds (wind, traffic, footsteps, fabric, impacts, breathing, laughter). Always write a real soundscape; do NOT write "N/A" here unless the user explicitly asked for silence. Never repeat the dialogue in this field.

non_diegetic_music — 1–3 sentences naming instrumentation, tempo, and dynamics of the background score the characters cannot hear. Avoid abstract mood words, and never put dialogue or diegetic sound here. If the scene calls for no score, write exactly "N/A".`,
};

/**
 * Used when no style is resolved for the target video model (no config override
 * and no upstream metadata). Per the product decision: still help vague
 * prompts, but DO NOT restyle — preserve whatever format the user wrote, only
 * making sure motion/camera intent is present.
 */
export const VIDEO_CLARIFY_ONLY_INSTRUCTION = `Target style: PRESERVE THE USER'S FORMAT.
You do not know this model's preferred prompt format, so KEEP the structure the user already used. Only clarify or lightly expand the prompt when it is genuinely vague — and if it lacks any sense of motion or camera, add a concise, natural motion/camera cue. If it is already detailed, return it essentially unchanged. Do not convert between prose and structured formats.`;
